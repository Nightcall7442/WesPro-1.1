// Тесты драйвера освещения Tuya (MOES WM4LT1): проверяем протокол —
// какие команды и на какой адрес уходят при открытии/закрытии сеанса.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TuyaLightingController } from "../src/services/lighting-tuya.js";
import { adminAgent, cashierAgent, createTable, createTariff, developerAgent, makeApp } from "./helpers.js";

function makeFakeClient() {
  const calls = [];
  return {
    calls,
    request(options) {
      calls.push(options);
      return Promise.resolve({ success: true });
    },
  };
}

const BINDINGS = {
  1: { device_id: "bf-table-1", switch_code: "switch_1" },
  2: { device_id: "bf-multi", switch_code: "switch_3" },
};

const resolveDevice = (tableId) => BINDINGS[tableId] ?? null;

test("включение света отправляет команду switch=true на устройство стола", async () => {
  const client = makeFakeClient();
  const lighting = new TuyaLightingController(client, resolveDevice);

  lighting.turnLightOn(1);
  await Promise.resolve(); // даём уйти асинхронной отправке

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], {
    method: "POST",
    path: "/v1.0/iot-03/devices/bf-table-1/commands",
    body: { commands: [{ code: "switch_1", value: true }] },
  });
  assert.ok(lighting.isLightOn(1));
});

test("выключение света отправляет команду switch=false", async () => {
  const client = makeFakeClient();
  const lighting = new TuyaLightingController(client, resolveDevice);

  lighting.turnLightOn(1);
  lighting.turnLightOff(1);
  await Promise.resolve();

  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[1].body, {
    commands: [{ code: "switch_1", value: false }],
  });
  assert.ok(!lighting.isLightOn(1));
});

test("многоканальный модуль: используется канал из привязки", async () => {
  const client = makeFakeClient();
  const lighting = new TuyaLightingController(client, resolveDevice);

  lighting.turnLightOn(2);
  await Promise.resolve();

  assert.deepEqual(client.calls[0].body, {
    commands: [{ code: "switch_3", value: true }],
  });
});

test("стол без привязки не ломает работу", async () => {
  const client = makeFakeClient();
  const lighting = new TuyaLightingController(client, resolveDevice);

  lighting.turnLightOn(99); // привязки нет — только предупреждение в лог
  await Promise.resolve();

  assert.equal(client.calls.length, 0);
  assert.ok(lighting.isLightOn(99)); // локальное состояние всё равно ведём
});

test("ошибка облака не приводит к необработанному исключению", async () => {
  const failingClient = {
    request: () => Promise.reject(new Error("cloud down")),
  };
  const lighting = new TuyaLightingController(failingClient, resolveDevice);

  lighting.turnLightOn(1); // не должно бросить
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(lighting.isLightOn(1));
});

test("ручное включение ждёт ответа реле и сообщает об отказе", async () => {
  const calls = [];
  const client = {
    request: async (options) => {
      calls.push(options);
      return options.body?.commands?.[0]?.value === true
        ? { success: true }
        : { success: false, msg: "device offline" };
    },
  };
  const lighting = new TuyaLightingController(client, () => ({
    device_id: "dev-1",
    switch_code: "switch_2",
  }));

  const on = await lighting.setLight(7, true);
  assert.equal(on, true);
  assert.equal(lighting.isLightOn(7), true);
  assert.equal(calls[0].body.commands[0].code, "switch_2");

  await assert.rejects(
    () => lighting.setLight(7, false),
    /device offline/,
    "отказ реле виден вызывающему"
  );
});

test("непривязанный стол честно говорит, что реле не выбрано", async () => {
  const lighting = new TuyaLightingController({ request: async () => ({ success: true }) }, () => null);
  await assert.rejects(() => lighting.setLight(1, true), /не привязан к реле/);
});

test("состояние света сверяется с самим реле", async () => {
  const client = {
    request: async (options) => {
      if (options.method === "GET") {
        return {
          success: true,
          result: [
            { code: "switch_1", value: true },
            { code: "countdown_1", value: 0 },
          ],
        };
      }
      return { success: true };
    },
  };
  const lighting = new TuyaLightingController(client, () => ({ device_id: "dev-1" }));

  assert.equal(lighting.isLightOn(3), false, "своя память пока пуста");
  const actual = await lighting.readLight(3);
  assert.equal(actual, true, "реле говорит, что свет горит");
  assert.equal(lighting.isLightOn(3), true, "память поправилась");
});

test("если облако недоступно, состояние света просто неизвестно", async () => {
  const lighting = new TuyaLightingController(
    { request: async () => { throw new Error("нет сети"); } },
    () => ({ device_id: "dev-1" })
  );
  assert.equal(await lighting.readLight(1), null, "ошибка не ломает кассу");
});

test("привести свет в порядок: над занятыми включить, над свободными погасить", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const busy = await createTable(admin, "Стол занят");
  const free = await createTable(admin, "Стол свободен");
  const tariff = await createTariff(admin);
  await admin.post(`/api/tables/${busy.id}/open`).send({ tariff_id: tariff.id });

  // На Mock-драйвере синхронизация ничего не делает — это защита от
  // лишних запросов, когда реле вообще не подключены. Настройка реле —
  // дело разработчика.
  const res = await dev.post("/api/lighting/sync");
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, 0);

  // Ручное включение/выключение — обычная операция, доступна и админу.
  const on = await admin.post(`/api/tables/${free.id}/light`).send({ on: true });
  assert.equal(on.body.light_on, true);
  const dashboard = await admin.get("/api/dashboard");
  assert.equal(dashboard.body.find((t) => t.id === free.id).light_on, true);

  const journal = await admin.get("/api/journal");
  assert.ok(
    journal.body.some((e) => /Включён свет над столом «Стол свободен» вручную/.test(e.message)),
    "ручное включение видно в журнале"
  );
});

test("привязка стола: тип устройства сохраняется и проверяется", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin);

  // Локальное реле Tasmota.
  const tasmota = await dev.put(`/api/tables/${table.id}/device`).send({
    kind: "tasmota",
    host: "192.168.1.50",
    channel: 1,
  });
  assert.equal(tasmota.status, 200);
  assert.equal(tasmota.body.light_kind, "tasmota");
  assert.equal(tasmota.body.light_host, "192.168.1.50");
  assert.equal(tasmota.body.light_channel, 1);

  // Своё устройство: два адреса.
  const custom = await dev.put(`/api/tables/${table.id}/device`).send({
    kind: "url",
    on_url: "http://192.168.1.60/on",
    off_url: "http://192.168.1.60/off",
  });
  assert.equal(custom.body.light_kind, "url");
  assert.equal(custom.body.light_on_url, "http://192.168.1.60/on");
  assert.equal(custom.body.light_host, null, "адрес в сети для этого типа не нужен");

  // Отвязка.
  const none = await dev.put(`/api/tables/${table.id}/device`).send({ kind: null });
  assert.equal(none.body.light_kind, null);
  assert.equal(none.body.light_on_url, null);
});

test("привязка объясняет, чего не хватает", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin);

  const noHost = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ kind: "shelly" });
  assert.equal(noHost.status, 409);
  assert.match(noHost.body.detail, /адрес устройства/i);

  const noUrls = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ kind: "url", on_url: "http://x/on" });
  assert.equal(noUrls.status, 409);
  assert.match(noUrls.body.detail, /адрес выключения/i);

  const badUrl = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ kind: "url", on_url: "javascript:alert(1)", off_url: "http://x/off" });
  assert.equal(badUrl.status, 409);
  assert.match(badUrl.body.detail, /http:\/\/ или https:\/\//);

  const badKind = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ kind: "zigbee-magic" });
  assert.equal(badKind.status, 409);
  assert.match(badKind.body.detail, /tuya, tasmota, shelly или url/);

  const badChannel = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ kind: "tasmota", host: "192.168.1.50", channel: 99 });
  assert.equal(badChannel.status, 409);
});

test("старая привязка Tuya понимается без указания типа", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin);

  // Так настраивали в прежних версиях: тип не присылали вовсе.
  const legacy = await dev
    .put(`/api/tables/${table.id}/device`)
    .send({ device_id: "bf1234567890", switch_code: "switch_2" });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.light_kind, "tuya", "тип подставлен сам");
  assert.equal(legacy.body.tuya_device_id, "bf1234567890");
  assert.equal(legacy.body.tuya_switch_code, "switch_2");
});

test("настройка реле закрыта от владельца, администратора и кассира — только разработчик", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const table = await createTable(admin);

  for (const agent of [admin, cashier]) {
    const bind = await agent
      .put(`/api/tables/${table.id}/device`)
      .send({ kind: "tasmota", host: "192.168.1.50" });
    assert.equal(bind.status, 403, "привязка реле недоступна");

    const sync = await agent.post("/api/lighting/sync");
    assert.equal(sync.status, 403, "синхронизация света недоступна");

    const devices = await agent.get("/api/settings/devices");
    assert.equal(devices.status, 403, "список устройств Tuya недоступен");
  }
});
