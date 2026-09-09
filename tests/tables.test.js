// Тесты создания столов.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { adminAgent, cashierAgent, makeApp } from "./helpers.js";

test("создание стола", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);

  const res = await request.post("/api/tables").send({ name: "Стол А" });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, "Стол А");
  assert.equal(res.body.status, "free");

  const list = await request.get("/api/tables");
  assert.deepEqual(
    list.body.map((t) => t.name),
    ["Стол А"]
  );
});

test("дубликат названия стола отклоняется", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);

  await request.post("/api/tables").send({ name: "Стол А" });
  const res = await request.post("/api/tables").send({ name: "Стол А" });
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /уже существует/);
});

test("создание стола пишется в журнал", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);

  await request.post("/api/tables").send({ name: "Стол А" });
  const journal = await request.get("/api/journal");
  assert.ok(journal.body.some((e) => e.event === "table_created"));
});

// --- Тариф закреплён за столом: кассир открывает время, цену задаёт админ ---

test("столу назначается тариф, и стол открывается без выбора тарифа", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = (await admin.post("/api/tables").send({ name: "Стол А" })).body;
  const дневной = (
    await admin.post("/api/tariffs").send({ name: "Дневной", price_per_hour: 400 })
  ).body;
  await admin.post("/api/tariffs").send({ name: "Ночной", price_per_hour: 900 });

  const assigned = await admin
    .put(`/api/tables/${table.id}/tariffs`)
    .send({ tariff_id: дневной.id });
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.body.tariff_ids, [дневной.id]);

  // Кассир открывает стол вообще без tariff_id — берётся тариф стола.
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({});
  assert.equal(opened.status, 201, "стол открылся без выбора тарифа");
  assert.equal(opened.body.tariff_name, "Дневной");
  assert.equal(opened.body.price_per_hour, 400, "цена — из тарифа стола");
});

test("дашборд отдаёт готовый тариф стола", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = (await admin.post("/api/tables").send({ name: "Стол А" })).body;
  const tariff = (
    await admin.post("/api/tariffs").send({ name: "Дневной", price_per_hour: 400 })
  ).body;

  const before = await admin.get("/api/dashboard");
  assert.equal(
    before.body.find((t) => t.id === table.id).tariff.assigned,
    false,
    "тариф столу ещё не назначен — берётся первый активный"
  );

  await admin.put(`/api/tables/${table.id}/tariffs`).send({ tariff_id: tariff.id });
  const after = await admin.get("/api/dashboard");
  const row = after.body.find((t) => t.id === table.id).tariff;
  assert.equal(row.id, tariff.id);
  assert.equal(row.name, "Дневной");
  assert.equal(row.price_per_hour, 400);
  assert.equal(row.assigned, true, "тариф закреплён за столом");
});

test("чужой тариф на столе с назначенным тарифом не принимается", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = (await admin.post("/api/tables").send({ name: "Стол А" })).body;
  const свой = (
    await admin.post("/api/tariffs").send({ name: "Дневной", price_per_hour: 400 })
  ).body;
  const чужой = (
    await admin.post("/api/tariffs").send({ name: "Ночной", price_per_hour: 900 })
  ).body;
  await admin.put(`/api/tables/${table.id}/tariffs`).send({ tariff_id: свой.id });

  const res = await admin
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: чужой.id });
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /не разрешён/);
});

test("смена тарифа стола видна в журнале", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = (await admin.post("/api/tables").send({ name: "Стол А" })).body;
  const tariff = (
    await admin.post("/api/tariffs").send({ name: "Дневной", price_per_hour: 400 })
  ).body;

  await admin.put(`/api/tables/${table.id}/tariffs`).send({ tariff_id: tariff.id });
  const journal = await admin.get("/api/journal");
  assert.ok(
    journal.body.some(
      (e) => /Столу «Стол А» назначен тариф: «Дневной»/.test(e.message)
    ),
    "в журнале видно, кому и какой тариф назначили"
  );
});

test("тариф стола назначает только тот, кому можно управлять столами", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const table = (await admin.post("/api/tables").send({ name: "Стол А" })).body;
  const tariff = (
    await admin.post("/api/tariffs").send({ name: "Дневной", price_per_hour: 400 })
  ).body;

  const res = await cashier
    .put(`/api/tables/${table.id}/tariffs`)
    .send({ tariff_id: tariff.id });
  assert.equal(res.status, 403, "кассир цену стола не меняет");
});
