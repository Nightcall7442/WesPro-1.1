// Устройства зала (кондиционер, вытяжка, приток): цикл «работает N минут —
// стоит M» и ручное управление. Реле не привязано — состояние ведёт
// заглушка, проверяем саму арифметику цикла и API.

import assert from "node:assert/strict";
import { test } from "node:test";

import { phaseOf, runDeviceCycles } from "../src/services/devices.js";
import { adminAgent, cashierAgent, makeApp } from "./helpers.js";

const MIN = 60_000;

test("фаза цикла считается от старта: 15 работает, 30 стоит, потом снова", () => {
  const t0 = Date.parse("2026-09-12T10:00:00Z");
  const device = {
    cycle_on: 1,
    cycle_started_at: new Date(t0).toISOString(),
    work_minutes: 15,
    rest_minutes: 30,
    is_on: 0,
  };
  assert.deepEqual(phaseOf(device, t0), { on: true, switchesIn: 15 * 60 });
  assert.deepEqual(phaseOf(device, t0 + 14 * MIN), { on: true, switchesIn: 60 });
  assert.deepEqual(phaseOf(device, t0 + 15 * MIN), { on: false, switchesIn: 30 * 60 });
  assert.deepEqual(phaseOf(device, t0 + 44 * MIN), { on: false, switchesIn: 60 });
  assert.deepEqual(phaseOf(device, t0 + 45 * MIN), { on: true, switchesIn: 15 * 60 });
  // Сутки спустя — ровно там же: ничего не накапливается.
  assert.deepEqual(phaseOf(device, t0 + 1440 * MIN + 5 * MIN), { on: true, switchesIn: 10 * 60 });
  // Цикл выключен — устройство в том состоянии, в каком его оставили.
  assert.deepEqual(phaseOf({ ...device, cycle_on: 0, is_on: 1 }, t0), { on: true, switchesIn: null });
});

test("тик приводит устройство к фазе цикла; ручное включение начинает цикл заново", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);

  const created = await admin
    .post("/api/devices")
    .send({ name: "Вытяжка", work_minutes: 15, rest_minutes: 30 });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.is_on, false);
  assert.equal(created.body.cycle_on, false);

  // Включили цикл — сразу работает.
  const cycle = await admin.post(`/api/devices/${id}/cycle`).send({ on: true });
  assert.equal(cycle.status, 200);
  assert.equal(cycle.body.cycle_on, true);
  assert.equal(cycle.body.is_on, true);
  assert.ok(cycle.body.switches_in_seconds <= 15 * 60);

  const startedAt = Date.parse(cycle.body.cycle_started_at);
  const stateOf = () => db.prepare("SELECT is_on FROM devices WHERE id = ?").get(id).is_on;

  // Через 20 минут тик выключает, через 50 — снова включает.
  assert.deepEqual(await runDeviceCycles(db, startedAt + 20 * MIN), { switched: 1 });
  assert.equal(stateOf(), 0);
  assert.deepEqual(await runDeviceCycles(db, startedAt + 30 * MIN), { switched: 0 });
  assert.deepEqual(await runDeviceCycles(db, startedAt + 50 * MIN), { switched: 1 });
  assert.equal(stateOf(), 1);

  // Кассир выключил руками во время работы — начинается полная пауза,
  // 30 минут ничего не включает, а потом цикл идёт дальше.
  const cashier = await cashierAgent(app, db);
  const off = await cashier.post(`/api/devices/${id}/power`).send({ on: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.is_on, false);
  const anchor = Date.parse(off.body.cycle_started_at);
  assert.deepEqual(await runDeviceCycles(db, anchor + 15 * MIN + 29 * MIN), { switched: 0 });
  assert.equal(stateOf(), 0);
  assert.deepEqual(await runDeviceCycles(db, anchor + 15 * MIN + 31 * MIN), { switched: 1 });
  assert.equal(stateOf(), 1);

  // Выключили цикл — устройство тоже выключилось и больше не трогается.
  const stop = await cashier.post(`/api/devices/${id}/cycle`).send({ on: false });
  assert.equal(stop.body.cycle_on, false);
  assert.equal(stop.body.is_on, false);
  assert.equal(stop.body.switches_in_seconds, null);
  assert.deepEqual(await runDeviceCycles(db, anchor + 999 * MIN), { switched: 0 });

  // Настройка — не кассирское дело.
  const denied = await cashier
    .post("/api/devices")
    .send({ name: "Кондиционер", work_minutes: 10, rest_minutes: 10 });
  assert.equal(denied.status, 403);
  const bad = await admin
    .post("/api/devices")
    .send({ name: "Приток", work_minutes: 0, rest_minutes: 10 });
  assert.equal(bad.status, 409);

  const list = await cashier.get("/api/devices");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].name, "Вытяжка");

  const removed = await admin.delete(`/api/devices/${id}`);
  assert.equal(removed.status, 200);
  assert.equal((await admin.get("/api/devices")).body.length, 0);
});
