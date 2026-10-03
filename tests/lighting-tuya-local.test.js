// Реле Tuya/MOES по локальной сети, без облака.
//
// Как и у Tasmota/Shelly, тесты поднимают фальшивое реле — здесь это
// TCP-сервер, который говорит настоящим протоколом Tuya 3.3 (шифрование
// локальным ключом). Так проверяется, что команды действительно доходят
// до устройства, а не наши представления о протоколе.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { test } from "node:test";

import TuyAPI from "tuyapi";
import { CommandType, MessageParser } from "tuyapi/lib/message-parser.js";

import {
  applyTuyaAddress,
  followTuyaAddresses,
  initLighting,
  localKeyToStore,
  parseRelayBinding,
} from "../src/services/lighting.js";
import { checkRelays, otherSubnet } from "../src/services/relay-check.js";
import {
  TuyaLocalLightingController,
  discoverTuyaDevices,
  forgetTuyaLocalVersions,
  subscribeTuyaAnnouncements,
} from "../src/services/lighting-tuya-local.js";
import { adminAgent, cashierAgent, createTable, createTariff, developerAgent, makeApp } from "./helpers.js";

const DEVICE_ID = "bf0123456789abcdefgh";
// Настоящие ключи бывают и со знаками препинания — пусть тест это помнит.
const LOCAL_KEY = "k3y!Secret#9xQz7";

/**
 * Фальшивое реле Tuya протокола 3.3: принимает команды, зашифрованные
 * его ключом, и отвечает как настоящее. Запоминает, что у него просили.
 */
async function fakeTuyaDevice(t, { key = LOCAL_KEY, dps = { 1: false, 2: false } } = {}) {
  const parser = new MessageParser({ key, version: "3.3" });
  const commands = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (data) => {
      let packets;
      try {
        packets = parser.parse(data);
      } catch {
        return; // повреждённый пакет — настоящее реле тоже молчит
      }
      for (const packet of packets) {
        const reply = (commandByte, payload) =>
          socket.write(parser.encode({ data: payload, commandByte, sequenceN: packet.sequenceN }));
        // Не расшифровалось своим ключом — команда зашифрована чужим.
        // Настоящее реле отвечает ошибкой, зашифрованной своим ключом:
        // для клиента это нечитаемый ответ.
        if (typeof packet.payload !== "object" && packet.commandByte !== CommandType.HEART_BEAT) {
          reply(packet.commandByte === CommandType.CONTROL ? CommandType.STATUS : packet.commandByte, "data format error");
          continue;
        }
        if (packet.commandByte === CommandType.CONTROL) {
          commands.push(packet.payload.dps);
          Object.assign(dps, packet.payload.dps);
          reply(CommandType.STATUS, { devId: DEVICE_ID, dps: { ...packet.payload.dps }, t: 1 });
        } else if (packet.commandByte === CommandType.DP_QUERY) {
          reply(CommandType.DP_QUERY, { devId: DEVICE_ID, gwId: DEVICE_ID, dps: { ...dps } });
        } else if (packet.commandByte === CommandType.HEART_BEAT) {
          reply(CommandType.HEART_BEAT, "");
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  forgetTuyaLocalVersions();
  return { port: server.address().port, commands, dps, sockets };
}

/** Настоящий клиент протокола (tuyapi), но на порт фальшивого реле. */
const clientOn = (port) => (options) =>
  new TuyAPI({ ...options, port, issueGetOnConnect: false });

const binding = (extra = {}) => () => ({
  device_id: DEVICE_ID,
  local_key: LOCAL_KEY,
  host: "127.0.0.1",
  version: "3.3",
  switch_code: "switch_1",
  ...extra,
});

test("Tuya по сети: включение, выключение и опрос состояния по протоколу 3.3", async (t) => {
  const device = await fakeTuyaDevice(t);
  const lighting = new TuyaLocalLightingController(binding(), {
    createClient: clientOn(device.port),
  });

  await lighting.setLight(1, true);
  assert.deepEqual(device.commands.at(-1), { 1: true });
  assert.equal(device.dps[1], true);
  assert.equal(lighting.isLightOn(1), true);
  assert.equal(await lighting.readLight(1), true, "реле подтверждает: включено");

  await lighting.setLight(1, false);
  assert.deepEqual(device.commands.at(-1), { 1: false });
  assert.equal(await lighting.readLight(1), false);
  assert.deepEqual(await lighting.probe(1), { online: true, ip: "127.0.0.1" });

  // После каждой команды соединение закрыто: реле держит одно за раз.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(device.sockets.size, 0, "соединения с реле не висят");
});

test("Tuya по сети: канал switch_2 — это второй DP реле", async (t) => {
  const device = await fakeTuyaDevice(t);
  const lighting = new TuyaLocalLightingController(binding({ switch_code: "switch_2" }), {
    createClient: clientOn(device.port),
  });
  await lighting.setLight(7, true);
  assert.deepEqual(device.commands.at(-1), { 2: true });
  assert.equal(device.dps[1], false, "первый канал не тронут");
});

test("Tuya по сети: команды к одному реле идут по очереди", async (t) => {
  const device = await fakeTuyaDevice(t);
  const lighting = new TuyaLocalLightingController(binding(), {
    createClient: clientOn(device.port),
  });
  await Promise.all([
    lighting.setLight(1, true),
    lighting.setLight(1, false),
    lighting.setLight(1, true),
  ]);
  assert.deepEqual(device.commands, [{ 1: true }, { 1: false }, { 1: true }]);
});

test("Tuya по сети: чужой ключ — понятная ошибка, а не зависание", async (t) => {
  const device = await fakeTuyaDevice(t, { key: "fedcba9876543210" });
  const lighting = new TuyaLocalLightingController(binding(), {
    createClient: clientOn(device.port),
    timeoutMs: 700,
  });
  await assert.rejects(lighting.setLight(1, true), /не приняло ключ/);
  assert.deepEqual(device.commands, [], "реле ничего не включило");
  assert.equal(await lighting.readLight(1), null, "состояние узнать не удалось");
  assert.deepEqual(await lighting.probe(1), { online: false });
});

test("Tuya по сети: реле выключено из сети — «нет связи» сразу, без перебора версий", async (t) => {
  const device = await fakeTuyaDevice(t);
  const tried = [];
  const lighting = new TuyaLocalLightingController(binding({ version: null }), {
    createClient: (options) => {
      tried.push(options.version);
      // Порт, на котором никто не слушает.
      return new TuyAPI({ ...options, port: 1, issueGetOnConnect: false });
    },
  });
  await assert.rejects(lighting.setLight(1, true), /отклонило подключение/);
  assert.equal(tried.length, 1, "отказ в подключении — другая версия не поможет");
  assert.equal(device.commands.length, 0);
});

test("Tuya по сети: по адресу никого нет — без перебора версий протокола", async () => {
  forgetTuyaLocalVersions();
  const tried = [];
  // 192.0.2.1 — адрес «для документации»: там гарантированно никого нет.
  const lighting = new TuyaLocalLightingController(binding({ host: "192.0.2.1", version: null }), {
    createClient: (options) => {
      tried.push(options.version);
      return new TuyAPI({ ...options, issueGetOnConnect: false });
    },
    timeoutMs: 400,
  });
  await assert.rejects(lighting.setLight(1, true), /недоступно по сети/);
  assert.equal(tried.length, 1, "версия тут ни при чём — ждать четыре раза незачем");
});

test("Tuya по сети: реле 3.4 обрывает соединение на чужой ключ — так и говорим", async (t) => {
  // Настоящее реле 3.4 на сообщение, зашифрованное не тем ключом, молча
  // закрывает соединение. Это не «недоступно по сети» — дело в ключе.
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  forgetTuyaLocalVersions();
  const lighting = new TuyaLocalLightingController(binding({ version: "3.4" }), {
    createClient: clientOn(server.address().port),
    timeoutMs: 700,
  });
  await assert.rejects(lighting.setLight(1, true), /не приняло ключ/);
});

test("Tuya по сети: версия не указана — подбирается и запоминается", async () => {
  forgetTuyaLocalVersions();
  const tried = [];
  // Поддельный клиент: отвечает только версии 3.5, как новое реле.
  const createClient = ({ version }) => {
    tried.push(version);
    return {
      on() {},
      async connect() {
        if (version !== "3.5") throw new Error("timeout");
      },
      async set() {
        return { dps: { 1: true } };
      },
      async get() {
        return true;
      },
      disconnect() {},
    };
  };
  const lighting = new TuyaLocalLightingController(binding({ version: null }), { createClient });

  await lighting.setLight(1, true);
  assert.deepEqual(tried, ["3.3", "3.4", "3.5"]);

  tried.length = 0;
  await lighting.setLight(1, false);
  assert.deepEqual(tried, ["3.5"], "второй раз — сразу запомненной версией");
});

test("Tuya по сети: без ключа или адреса команду не отправить", async () => {
  const lighting = new TuyaLocalLightingController(binding({ local_key: null }));
  await assert.rejects(lighting.setLight(1, true), /локальный ключ/);
  assert.deepEqual(await lighting.probe(1), { online: null });

  const noHost = new TuyaLocalLightingController(binding({ host: null }));
  await assert.rejects(noHost.setLight(1, true), /IP-адрес/);
});

test("привязка tuya_local: проверка полей и ключ как пароль", () => {
  const relay = parseRelayBinding({
    kind: "tuya_local",
    device_id: DEVICE_ID,
    host: "192.168.1.60",
    local_key: LOCAL_KEY,
    switch_code: "switch_3",
    version: "3.4",
  });
  assert.equal(relay.light_kind, "tuya_local");
  assert.equal(relay.tuya_device_id, DEVICE_ID);
  assert.equal(relay.light_host, "192.168.1.60");
  assert.equal(relay.tuya_switch_code, "switch_3");
  assert.equal(relay.tuya_local_key, LOCAL_KEY);
  assert.equal(relay.tuya_version, "3.4");

  const base = { kind: "tuya_local", device_id: DEVICE_ID, host: "192.168.1.60" };
  assert.throws(() => parseRelayBinding({ ...base, device_id: "" }), /ID устройства/);
  assert.throws(() => parseRelayBinding({ ...base, host: "" }), /адрес/);
  assert.throws(() => parseRelayBinding({ ...base, host: "http://192.168.1.60" }), /только IP/);
  assert.throws(() => parseRelayBinding({ ...base, local_key: "short" }), /16 символов/);
  assert.throws(() => parseRelayBinding({ ...base, version: "2.0" }), /Версия протокола/);

  // Пустой ключ — «оставить сохранённый»; нет и сохранённого — ошибка.
  const keyless = parseRelayBinding(base);
  assert.equal(keyless.tuya_local_key, null);
  assert.equal(localKeyToStore(keyless, LOCAL_KEY), LOCAL_KEY);
  assert.throws(() => localKeyToStore(keyless, null), /локальный ключ/);
  // Другой тип реле — ключ стирается.
  assert.equal(localKeyToStore(parseRelayBinding({ kind: "tasmota", host: "1.2.3.4" }), LOCAL_KEY), null);
});

test("поиск в сети: реле Tuya сообщает о себе широковещательно — находим ID, IP и версию", async () => {
  const udpKey = crypto.createHash("md5").update("yGAdlopoPVldABfn", "utf8").digest();
  const packet = new MessageParser({ key: udpKey, version: "3.3" }).encode({
    data: { ip: "192.168.1.77", gwId: DEVICE_ID, active: 2, encrypt: true, productKey: "keyabc", version: "3.3" },
    commandByte: CommandType.UDP_NEW,
  });
  // Свободный порт: как у реле, только не 6667 (он может быть занят).
  const probe = dgram.createSocket("udp4");
  await new Promise((resolve) => probe.bind(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  probe.close();

  const sender = dgram.createSocket("udp4");
  const timer = setInterval(() => sender.send(packet, port, "127.0.0.1"), 30);
  try {
    const found = await discoverTuyaDevices({ ports: [port], timeoutMs: 300 });
    assert.deepEqual(found, [
      { id: DEVICE_ID, ip: "192.168.1.77", version: "3.3", product_key: "keyabc" },
    ]);
  } finally {
    clearInterval(timer);
    sender.close();
  }
});

// --- Через программу: привязка, ключ как пароль, свет при открытии стола ---

const tuyaLocalBody = (extra = {}) => ({
  kind: "tuya_local",
  device_id: DEVICE_ID,
  host: "127.0.0.1",
  local_key: LOCAL_KEY,
  version: "3.3",
  switch_code: "switch_1",
  ...extra,
});

test("привязка стола к Tuya по сети: ключ сохраняется, но наружу не отдаётся", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const cashier = await cashierAgent(app, db);
  const table = await createTable(admin, "Стол 1");

  // Без ключа первый раз не сохранить — реле им не скомандовать.
  const keyless = await dev
    .put(`/api/tables/${table.id}/device`)
    .send(tuyaLocalBody({ local_key: "" }));
  assert.equal(keyless.status, 409);
  assert.match(keyless.body.detail, /локальный ключ/);

  const saved = await dev.put(`/api/tables/${table.id}/device`).send(tuyaLocalBody());
  assert.equal(saved.status, 200);
  assert.equal(saved.body.light_kind, "tuya_local");
  assert.equal(saved.body.light_host, "127.0.0.1");
  assert.equal(saved.body.tuya_version, "3.3");
  assert.ok(saved.body.has_local_key, "видно, что ключ сохранён");
  assert.equal(saved.body.tuya_local_key, undefined, "но сам ключ не отдаётся");

  for (const agent of [admin, cashier, dev]) {
    const tables = await agent.get("/api/tables");
    assert.ok(!JSON.stringify(tables.body).includes(LOCAL_KEY), "ключа нет в списке столов");
    const dashboard = await agent.get("/api/dashboard");
    assert.ok(!JSON.stringify(dashboard.body).includes(LOCAL_KEY), "и на дашборде");
  }

  // Пустой ключ при правке — оставить прежний (поле ключа в интерфейсе пустое).
  const edited = await dev
    .put(`/api/tables/${table.id}/device`)
    .send(tuyaLocalBody({ local_key: "", host: "127.0.0.2", switch_code: "switch_2" }));
  assert.equal(edited.status, 200);
  const row = () =>
    db.prepare("SELECT tuya_local_key, light_host, tuya_switch_code FROM tables WHERE id = ?").get(table.id);
  assert.deepEqual({ ...row() }, {
    tuya_local_key: LOCAL_KEY,
    light_host: "127.0.0.2",
    tuya_switch_code: "switch_2",
  });

  // Сменили тип реле — ключ стёрт, он больше ни к чему.
  await dev.put(`/api/tables/${table.id}/device`).send({ kind: "tasmota", host: "192.168.1.50" });
  assert.equal(row().tuya_local_key, null);

  // Привязка — только разработчик.
  const denied = await admin.put(`/api/tables/${table.id}/device`).send(tuyaLocalBody());
  assert.equal(denied.status, 403);
});

test("Tuya по сети: свет над столом включается при открытии и вручную", async (t) => {
  const device = await fakeTuyaDevice(t);
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin, "Стол 1");
  const tariff = await createTariff(admin);
  await dev.put(`/api/tables/${table.id}/device`).send(tuyaLocalBody());
  await initLighting(db, { tuyaLocal: { createClient: clientOn(device.port) } });

  // Открыли стол — команда ушла на реле (не дожидаясь ответа, касса не ждёт).
  const opened = await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  assert.equal(opened.status, 201);
  for (let i = 0; i < 50 && device.dps[1] !== true; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(device.dps[1], true, "свет над столом включён");

  // Ручное выключение ждёт ответа реле.
  const off = await admin.post(`/api/tables/${table.id}/light`).send({ on: false });
  assert.equal(off.status, 200);
  assert.equal(device.dps[1], false);

  // Таблица реле: тип и IP — адрес привязки.
  const relays = await admin.get("/api/relays");
  const relay = relays.body.find((r) => r.scope === "table" && r.id === table.id);
  assert.equal(relay.kind, "tuya_local");
  assert.equal(relay.ip, "127.0.0.1");
  assert.ok(!JSON.stringify(relays.body).includes(LOCAL_KEY));
});

test("устройство зала на Tuya по сети: ключ не отдаётся в списке устройств", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  await developerAgent(app, db);
  const created = await admin
    .post("/api/devices")
    .send({ name: "Вытяжка", work_minutes: 15, rest_minutes: 30, ...tuyaLocalBody() });
  assert.equal(created.status, 201);
  assert.equal(created.body.light_kind, "tuya_local");
  assert.equal(created.body.has_local_key, true);
  assert.equal(created.body.tuya_local_key, undefined);

  // Интерфейс шлёт всю строку целиком, но ключ — пустым: прежний остаётся.
  const updated = await admin
    .put(`/api/devices/${created.body.id}`)
    .send({ name: "Вытяжка", work_minutes: 20, rest_minutes: 30, ...tuyaLocalBody({ local_key: "" }) });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.has_local_key, true);
  assert.equal(
    db.prepare("SELECT tuya_local_key FROM devices WHERE id = ?").get(created.body.id).tuya_local_key,
    LOCAL_KEY
  );
  const list = await admin.get("/api/devices");
  assert.ok(!JSON.stringify(list.body).includes(LOCAL_KEY));
});

test("поиск реле Tuya в сети — только разработчику", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  for (const agent of [admin, cashier]) {
    const res = await agent.get("/api/settings/tuya-lan");
    assert.equal(res.status, 403);
  }
});

// --- Адрес реле сменился — программа находит его сама ---------------------

/** Свободный UDP-порт на этой машине — вместо 6667, который может быть занят. */
async function freeUdpPort() {
  const probe = dgram.createSocket("udp4");
  await new Promise((resolve) => probe.bind(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  probe.close();
  return port;
}

/** Сообщение реле о себе — как его рассылает настоящее реле Tuya 3.3. */
function announcement(ip, id = DEVICE_ID) {
  const udpKey = crypto.createHash("md5").update("yGAdlopoPVldABfn", "utf8").digest();
  return new MessageParser({ key: udpKey, version: "3.3" }).encode({
    data: { ip, gwId: id, active: 2, encrypt: true, productKey: "keyabc", version: "3.3" },
    commandByte: CommandType.UDP_NEW,
  });
}

test("реле сменило адрес — программа узнаёт его по ID и поправляет привязку", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const table = await createTable(admin, "Стол 1");
  await dev.put(`/api/tables/${table.id}/device`).send(tuyaLocalBody({ host: "192.168.1.3" }));

  // Чужое реле и тот же адрес — ничего не трогаем.
  assert.equal(applyTuyaAddress(db, { id: "bfsomeoneelse000000", ip: "192.168.1.9" }), 0);
  assert.equal(applyTuyaAddress(db, { id: DEVICE_ID, ip: "192.168.1.3" }), 0);

  const port = await freeUdpPort();
  const stop = await followTuyaAddresses(db, { ports: [port] });
  const sender = dgram.createSocket("udp4");
  try {
    const host = () => db.prepare("SELECT light_host FROM tables WHERE id = ?").get(table.id).light_host;
    for (let i = 0; i < 50 && host() !== "192.168.1.7"; i += 1) {
      sender.send(announcement("192.168.1.7"), port, "127.0.0.1");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(host(), "192.168.1.7", "новый адрес записан");
    const journal = await admin.get("/api/journal");
    assert.ok(
      journal.body.some((e) => /Стол «Стол 1»: реле сменило адрес 192\.168\.1\.3 → 192\.168\.1\.7/.test(e.message)),
      "смена адреса видна в журнале"
    );
    assert.ok(!JSON.stringify(journal.body).includes(LOCAL_KEY));
  } finally {
    stop();
    sender.close();
  }
});

test("проверка реле при запуске: кто отвечает, кто нет", async (t) => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const up = await createTable(admin, "Стол 1");
  const down = await createTable(admin, "Стол 2");
  const tasmota = await createTable(admin, "Стол 3");
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  await dev.put(`/api/tables/${up.id}/device`).send(tuyaLocalBody({ host: "127.0.0.1" }));
  // 192.0.2.1 — адрес «для документации»: там никого нет.
  await dev.put(`/api/tables/${down.id}/device`).send(tuyaLocalBody({ host: "192.0.2.1" }));
  await dev.put(`/api/tables/${tasmota.id}/device`).send({ kind: "tasmota", host: `http://127.0.0.1:${port}/` });

  const results = await checkRelays(db, { timeoutMs: 500, ports: { tuya_local: port, tasmota: 80 } });
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(byName["Стол 1"].ok, true);
  assert.equal(byName["Стол 1"].label, "Tuya / MOES по сети");
  assert.equal(byName["Стол 2"].ok, false);
  assert.equal(byName["Стол 3"].ok, true, "порт из адреса Tasmota учитывается");
  assert.equal(byName["Стол 3"].host, "127.0.0.1");

  assert.equal(otherSubnet("192.168.5.10", ["192.168.1.42"]), true);
  assert.equal(otherSubnet("192.168.1.3", ["192.168.1.42"]), false);
});

test("поиск в сети сразу показывает реле, которые программа слышала недавно", async () => {
  // Программа слушает сеть постоянно (слежение за адресами). По Wi-Fi
  // сообщения реле теряются, поэтому поиск не ждёт следующего, а берёт
  // слышанных за последнюю минуту.
  const port = await freeUdpPort();
  const seen = [];
  const stop = await subscribeTuyaAnnouncements((device) => seen.push(device), { ports: [port] });
  const sender = dgram.createSocket("udp4");
  try {
    for (let i = 0; i < 50 && !seen.length; i += 1) {
      sender.send(announcement("192.168.1.3"), port, "127.0.0.1");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Реле замолчало — а поиск всё равно его знает.
    const found = await discoverTuyaDevices({ ports: [port], timeoutMs: 50 });
    assert.deepEqual(found.map((d) => [d.id, d.ip]), [[DEVICE_ID, "192.168.1.3"]]);
  } finally {
    stop();
    sender.close();
  }
});

// --- Ключи из облака одной кнопкой ---------------------------------------

const OTHER_ID = "bf9876543210zyxwvuts";
const OTHER_KEY = "0th3r<Key>&Pass!";

/** Поддельное облако Tuya: список устройств приложения и их подробности. */
function fakeCloud(keys = { [DEVICE_ID]: LOCAL_KEY, [OTHER_ID]: OTHER_KEY }) {
  const calls = [];
  return {
    calls,
    request: async ({ path }) => {
      calls.push(path);
      if (path.startsWith("/v1.0/iot-01/associated-users/devices")) {
        return {
          success: true,
          result: { devices: [{ id: DEVICE_ID, name: "Реле стол 1" }, { id: OTHER_ID, name: "Реле стол 2" }] },
        };
      }
      const id = path.split("/").pop();
      if (keys[id]) return { success: true, result: { id, name: `Имя ${id.slice(0, 4)}`, local_key: keys[id], is_online: true } };
      return { success: false, msg: "device not found" };
    },
  };
}

test("ключи из облака: одной кнопкой, без копирования и без выдачи наружу", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const dev = await developerAgent(app, db);
  const t1 = await createTable(admin, "Стол 1");
  const t2 = await createTable(admin, "Стол 2");

  // Без ключей проекта облако не спросить — понятная подсказка.
  const noCreds = await dev.post("/api/settings/tuya-keys");
  assert.equal(noCreds.status, 409);
  assert.match(noCreds.body.detail, /Access ID и Access Secret/);

  // Ключи проекта сохранены, драйвер света оставлен «Выключено».
  await dev.put("/api/settings").send({ lighting_driver: "mock", tuya_access_id: "id123", tuya_access_secret: "secret456" });
  const cloud = fakeCloud();
  await initLighting(db, { tuyaCloud: () => cloud });

  // Стол 1 привязан со старым ключом (реле потом переустановили).
  await dev.put(`/api/tables/${t1.id}/device`).send(tuyaLocalBody({ local_key: "oldKey0000000001" }));

  const fetched = await dev.post("/api/settings/tuya-keys");
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.devices.length, 2);
  assert.equal(fetched.body.updated, 1, "старый ключ стола 1 заменён");
  assert.deepEqual(fetched.body.devices.find((d) => d.id === DEVICE_ID).bound_to, ["Стол 1"]);
  for (const body of [fetched.body, (await dev.get("/api/settings/tuya-keys")).body]) {
    const text = JSON.stringify(body);
    assert.ok(!text.includes(LOCAL_KEY) && !text.includes(OTHER_KEY), "ключи не уходят наружу");
  }
  const keyOf = (id) => db.prepare("SELECT tuya_local_key FROM tables WHERE id = ?").get(id).tuya_local_key;
  assert.equal(keyOf(t1.id), LOCAL_KEY);

  // Новая привязка без ключа — ключ подставился из облака.
  const bound = await dev
    .put(`/api/tables/${t2.id}/device`)
    .send(tuyaLocalBody({ device_id: OTHER_ID, local_key: "" }));
  assert.equal(bound.status, 200);
  assert.ok(bound.body.has_local_key);
  assert.equal(keyOf(t2.id), OTHER_KEY);

  // Сменили у стола 1 реле на другое — чужой сохранённый ключ не тянется:
  // берётся ключ нового реле из облака.
  await dev.put(`/api/tables/${t1.id}/device`).send(tuyaLocalBody({ device_id: OTHER_ID, local_key: "" }));
  assert.equal(keyOf(t1.id), OTHER_KEY);

  const journal = await admin.get("/api/journal");
  assert.ok(journal.body.some((e) => /Получены ключи реле Tuya из облака: 2/.test(e.message)));

  for (const agent of [admin]) {
    assert.equal((await agent.post("/api/settings/tuya-keys")).status, 403);
    assert.equal((await agent.get("/api/settings/tuya-keys")).status, 403);
  }
});

test("ключи из облака: облако ничего не отдало — объясняем, что проверить", async () => {
  const { db, app } = makeApp();
  const dev = await developerAgent(app, db);
  await dev.put("/api/settings").send({ tuya_access_id: "id123", tuya_access_secret: "secret456" });
  await initLighting(db, {
    tuyaCloud: () => ({ request: async () => ({ success: false, msg: "permission deny" }) }),
  });
  const res = await dev.post("/api/settings/tuya-keys");
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /Link Tuya App Account/);
});
