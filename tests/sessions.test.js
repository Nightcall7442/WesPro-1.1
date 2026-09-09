// Тесты открытия и закрытия сеансов.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { getLightingController } from "../src/services/lighting.js";
import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

test("открытие стола", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);
  const table = await createTable(request);
  const tariff = await createTariff(request);

  const res = await request
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(res.status, 201);
  assert.equal(res.body.table_id, table.id);
  assert.equal(res.body.ended_at, null);
  assert.equal(res.body.total_cost, null);
  assert.equal(res.body.price_per_hour, 600);

  const dashboard = await request.get("/api/dashboard");
  const row = dashboard.body.find((t) => t.id === table.id);
  assert.equal(row.status, "busy");
  assert.equal(row.light_on, true);
  assert.equal(row.session.session_id, res.body.id);
  assert.ok(getLightingController().isLightOn(table.id));
});

test("закрытие стола", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);
  const table = await createTable(request);
  const tariff = await createTariff(request);
  await request.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });

  const res = await request.post(`/api/tables/${table.id}/close`);
  assert.equal(res.status, 200);
  assert.notEqual(res.body.ended_at, null);
  assert.notEqual(res.body.total_cost, null);

  const dashboard = await request.get("/api/dashboard");
  const row = dashboard.body.find((t) => t.id === table.id);
  assert.equal(row.status, "free");
  assert.equal(row.session, null);
  assert.equal(row.light_on, false);
  assert.ok(!getLightingController().isLightOn(table.id));

  const history = await request.get("/api/history");
  assert.deepEqual(
    history.body.map((s) => s.id),
    [res.body.id]
  );

  const journal = await request.get("/api/journal");
  const events = journal.body.map((e) => e.event);
  for (const expected of ["session_opened", "light_on", "session_closed", "light_off"]) {
    assert.ok(events.includes(expected), `нет события ${expected}`);
  }
});

test("невозможно открыть занятый стол", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);
  const table = await createTable(request);
  const tariff = await createTariff(request);
  await request.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });

  const res = await request
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /уже занят/);

  const dashboard = await request.get("/api/dashboard");
  assert.equal(dashboard.body.filter((t) => t.session).length, 1);
});

test("невозможно закрыть свободный стол", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);
  const table = await createTable(request);

  const res = await request.post(`/api/tables/${table.id}/close`);
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /свободен/);

  const history = await request.get("/api/history");
  assert.deepEqual(history.body, []);
});

test("несуществующие стол и тариф дают 404", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);
  const table = await createTable(request);
  const tariff = await createTariff(request);

  const noTable = await request
    .post("/api/tables/9999/open")
    .send({ tariff_id: tariff.id });
  assert.equal(noTable.status, 404);

  const noTariff = await request
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: 9999 });
  assert.equal(noTariff.status, 404);
});
