// Адреса для входа с других устройств: список интерфейсов и API.
// Сервер слушает все интерфейсы сразу, поэтому здесь важно, что список
// адресов полный (а не «первый попавшийся») и виртуальные сети помечены.

import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";

import { lanAddresses, networkInfo, subnetPrefix } from "../src/services/network.js";
import { adminAgent, cashierAgent, developerAgent, makeApp } from "./helpers.js";

test("список адресов: все внешние IPv4, без 127.0.0.1", () => {
  const addresses = lanAddresses();
  const expected = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);

  assert.deepEqual(
    addresses.map((a) => a.address).sort(),
    expected.sort(),
    "перечислены все внешние адреса, а не только первый"
  );
  assert.ok(!addresses.some((a) => a.address === "127.0.0.1"));
  for (const item of addresses) {
    assert.ok(item.iface, "у адреса есть имя адаптера");
    assert.equal(typeof item.virtual, "boolean");
  }
});

test("виртуальные адаптеры уходят в конец списка", () => {
  // Подменяем список интерфейсов: обычный адаптер идёт вторым, но в
  // результате должен оказаться первым.
  const original = os.networkInterfaces;
  os.networkInterfaces = () => ({
    "VirtualBox Host-Only Network": [
      { family: "IPv4", address: "192.168.56.1", netmask: "255.255.255.0", internal: false },
    ],
    "Беспроводная сеть": [
      { family: "IPv4", address: "192.168.1.7", netmask: "255.255.255.0", internal: false },
    ],
    lo: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
  });
  try {
    const addresses = lanAddresses();
    assert.equal(addresses.length, 2);
    assert.equal(addresses[0].address, "192.168.1.7", "настоящая сеть первая");
    assert.equal(addresses[0].virtual, false);
    assert.equal(addresses[1].address, "192.168.56.1");
    assert.equal(addresses[1].virtual, true, "VirtualBox помечен как виртуальный");
  } finally {
    os.networkInterfaces = original;
  }
});

test("подсеть — первые три числа адреса", () => {
  assert.equal(subnetPrefix("192.168.1.7"), "192.168.1");
  assert.equal(subnetPrefix("10.0.5.23"), "10.0.5");
});

test("networkInfo отдаёт готовые ссылки с портом", () => {
  const info = networkInfo(8000);
  assert.equal(info.port, 8000);
  assert.ok(info.hostname);
  for (const item of info.addresses) {
    assert.equal(item.url, `http://${item.address}:8000`);
    assert.equal(item.subnet, subnetPrefix(item.address));
  }
});

test("GET /api/network: доступен только разработчику", async () => {
  const { app, db } = makeApp();
  const developer = await developerAgent(app, db);
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);

  const res = await developer.get("/api/network");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.addresses));
  assert.ok(res.body.port > 0);

  assert.equal((await admin.get("/api/network")).status, 403, "владельцу/админу закрыто");
  assert.equal((await cashier.get("/api/network")).status, 403);
});
