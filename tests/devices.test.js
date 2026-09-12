// Устройства зала (кондиционер, вытяжка, приток): цикл «работает N минут —
// стоит M» и ручное управление. Реле не привязано — состояние ведёт
// заглушка, проверяем саму арифметику цикла и API.

import assert from "node:assert/strict";
import { test } from "node:test";

import { phaseOf, runDeviceCycles } from "../src/services/devices.js";
import { adminAgent, cashierAgent, createTable, developerAgent, makeApp } from "./helpers.js";

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

test("решётка канала: положения 30/50/70, закрыть, у решётки с одним положением — реле", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);

  const bad = await admin
    .post("/api/devices")
    .send({ name: "Решётка", type: "damper", positions: "30,150" });
  assert.equal(bad.status, 409);

  const created = await admin
    .post("/api/devices")
    .send({ name: "Решётка 1", type: "damper", positions: "70, 30,50,30" });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.positions, [30, 50, 70]); // отсортированы, без дублей
  assert.equal(created.body.position, 0);
  const id = created.body.id;

  const half = await admin.post(`/api/devices/${id}/position`).send({ percent: 50 });
  assert.equal(half.status, 200);
  assert.equal(half.body.position, 50);
  assert.equal(half.body.is_on, true);

  const wrong = await admin.post(`/api/devices/${id}/position`).send({ percent: 40 });
  assert.equal(wrong.status, 409);

  // Цикла у решётки нет; «включить» — открыть до упора, «выключить» — закрыть.
  assert.equal((await admin.post(`/api/devices/${id}/cycle`).send({ on: true })).status, 409);
  const full = await admin.post(`/api/devices/${id}/power`).send({ on: true });
  assert.equal(full.body.position, 70);
  const closed = await admin.post(`/api/devices/${id}/position`).send({ percent: 0 });
  assert.equal(closed.body.position, 0);
  assert.equal(closed.body.is_on, false);

  // Одно положение — обычная заслонка: открыто/закрыто.
  const flap = await admin
    .post("/api/devices")
    .send({ name: "Заслонка", type: "damper", positions: "100" });
  assert.deepEqual(flap.body.positions, [100]);
  const open = await admin.post(`/api/devices/${flap.body.id}/position`).send({ percent: 100 });
  assert.equal(open.body.is_on, true);
  assert.equal(db.prepare("SELECT is_on FROM devices WHERE id = ?").get(flap.body.id).is_on, 1);

  // Положение задаётся только решётке.
  const fan = await admin.post("/api/devices").send({ name: "Вытяжка", type: "exhaust" });
  assert.equal((await admin.post(`/api/devices/${fan.body.id}/position`).send({ percent: 50 })).status, 409);
});

test("устройство ставится на план зала и уходит с него вместе с устройством", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const fan = await admin.post("/api/devices").send({ name: "Вытяжка", type: "exhaust" });

  const ghost = await admin.put("/api/plan").send({
    cols: 20,
    rows: 10,
    elements: [{ type: "device", device_id: 999, x: 1, y: 1, w: 2, h: 1 }],
  });
  assert.equal(ghost.status, 409);

  const saved = await admin.put("/api/plan").send({
    cols: 20,
    rows: 10,
    elements: [
      { type: "wall", x: 0, y: 0, w: 20, h: 1 },
      { type: "device", device_id: fan.body.id, x: 1, y: 1, w: 2, h: 1 },
    ],
  });
  assert.equal(saved.status, 200);
  const placed = saved.body.elements.find((e) => e.type === "device");
  assert.equal(placed.device_id, fan.body.id);

  await admin.delete(`/api/devices/${fan.body.id}`);
  const after = await admin.get("/api/plan");
  assert.deepEqual(after.body.elements.map((e) => e.type), ["wall"]);
});

test("связь с реле: опрос показывает, кто в сети, а кто молчит", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin, "Стол у окна");
  // Порт 1 никто не слушает — такое реле «не в сети».
  await dev.put(`/api/tables/${table.id}/device`).send({ kind: "tasmota", host: "127.0.0.1:1" });
  await admin.post("/api/devices").send({ name: "Вытяжка", type: "exhaust" });
  await admin
    .post("/api/devices")
    .send({ name: "Приток", type: "intake", kind: "tasmota", host: "127.0.0.1:1" });
  // Сохранение настроек поднимает настоящие драйверы реле (в тестах
  // по умолчанию заглушка).
  await admin.put("/api/settings").send({});

  const probe = await admin.post("/api/relays/probe");
  assert.equal(probe.status, 200);
  assert.equal(probe.body.probed, 2);

  // В таблице реле — и столы, и устройства; без реле — не реле.
  const relays = (await admin.get("/api/relays")).body;
  assert.deepEqual(
    relays.map((r) => `${r.scope}:${r.name}`),
    ["table:Стол у окна", "device:Приток"]
  );
  const tableRelay = relays[0];
  assert.equal(tableRelay.kind, "tasmota");
  assert.equal(tableRelay.ip, "127.0.0.1:1", "у локального реле IP — адрес привязки");
  assert.equal(tableRelay.mac, null);
  assert.equal(tableRelay.online, false);
  assert.equal(tableRelay.light_on, false);
  assert.equal(tableRelay.last_seen, null);

  const devices = (await admin.get("/api/devices")).body;
  assert.equal(devices.find((d) => d.name === "Вытяжка").online, null, "без реле — нечего опрашивать");
  assert.equal(devices.find((d) => d.name === "Приток").online, false);

  // IP и MAC руками: стол — только разработчик, устройство — кто ведёт настройки.
  const denied = await admin
    .put(`/api/relays/table/${table.id}/net`)
    .send({ ip: "127.0.0.1:2", mac: "a4-cf-12-34-56-78" });
  assert.equal(denied.status, 403);
  const saved = await dev
    .put(`/api/relays/table/${table.id}/net`)
    .send({ ip: "127.0.0.1:2", mac: "a4-cf-12-34-56-78" });
  assert.equal(saved.status, 200);
  const badMac = await dev.put(`/api/relays/table/${table.id}/net`).send({ ip: "127.0.0.1:2", mac: "hello" });
  assert.equal(badMac.status, 409);
  const intake = devices.find((d) => d.name === "Приток");
  const savedDevice = await admin
    .put(`/api/relays/device/${intake.id}/net`)
    .send({ ip: "10.0.0.7", mac: "" });
  assert.equal(savedDevice.status, 200);

  const after = (await admin.get("/api/relays")).body;
  assert.equal(after[0].ip, "127.0.0.1:2");
  assert.equal(after[0].mac, "A4:CF:12:34:56:78", "MAC приводится к одному виду");
  assert.equal(after[1].ip, "10.0.0.7");
  assert.equal(after[1].mac, null);
  // Адрес привязки стола тоже сменился — реле дёргается по новому.
  assert.equal((await admin.get("/api/tables")).body[0].light_host, "127.0.0.1:2");
});
