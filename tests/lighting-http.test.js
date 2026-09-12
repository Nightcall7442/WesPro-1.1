// Реле в локальной сети: Tasmota, Shelly (Gen1 и Gen2) и «своё
// устройство» с произвольными адресами.
//
// Тесты поднимают настоящее фальшивое реле на http и смотрят, какие
// запросы к нему уходят — так проверяется именно протокол, а не наши
// представления о нём.

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  HttpLightingController,
  forgetShellyGenerations,
} from "../src/services/lighting-http.js";

/**
 * Фальшивое реле. Отвечает как настоящее и запоминает, что у него
 * просили.
 * @param {(url: URL) => object|string|null} handler null — ответить 404
 */
async function fakeDevice(t, handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    calls.push(req.url);
    const answer = handler(url);
    if (answer === null) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(typeof answer === "string" ? answer : JSON.stringify(answer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  forgetShellyGenerations();
  return { host: `127.0.0.1:${server.address().port}`, calls };
}

test("Tasmota: включение, выключение и опрос состояния", async (t) => {
  let power = "OFF";
  const device = await fakeDevice(t, (url) => {
    const cmnd = url.searchParams.get("cmnd") ?? "";
    if (/Power1 On/i.test(cmnd)) power = "ON";
    else if (/Power1 Off/i.test(cmnd)) power = "OFF";
    return { POWER1: power };
  });

  const lighting = new HttpLightingController(() => ({
    kind: "tasmota",
    host: device.host,
    channel: 0,
  }));

  await lighting.setLight(1, true);
  assert.match(device.calls.at(-1), /\/cm\?cmnd=Power1%20On/);
  assert.equal(lighting.isLightOn(1), true);
  assert.equal(await lighting.readLight(1), true, "реле подтверждает: горит");

  await lighting.setLight(1, false);
  assert.match(device.calls.at(-1), /\/cm\?cmnd=Power1%20Off/);
  assert.equal(await lighting.readLight(1), false);
});

test("Tasmota: второй канал модуля — Power2", async (t) => {
  const device = await fakeDevice(t, () => ({ POWER2: "ON" }));
  const lighting = new HttpLightingController(() => ({
    kind: "tasmota",
    host: device.host,
    channel: 1,
  }));
  await lighting.setLight(3, true);
  assert.match(device.calls.at(-1), /Power2%20On/);
  assert.equal(await lighting.readLight(3), true);
});

test("Shelly Gen1: /relay/0?turn=on", async (t) => {
  let ison = false;
  const device = await fakeDevice(t, (url) => {
    if (!url.pathname.startsWith("/relay/")) return null;
    const turn = url.searchParams.get("turn");
    if (turn === "on") ison = true;
    if (turn === "off") ison = false;
    return { ison };
  });

  const lighting = new HttpLightingController(() => ({
    kind: "shelly",
    host: device.host,
    channel: 0,
  }));
  await lighting.setLight(2, true);
  assert.match(device.calls.at(-1), /\/relay\/0\?turn=on/);
  assert.equal(await lighting.readLight(2), true);
});

test("Shelly Gen2 понимается сам, без выбора поколения руками", async (t) => {
  let output = false;
  const device = await fakeDevice(t, (url) => {
    // Второе поколение адресов первого не знает — отвечает 404.
    if (url.pathname.startsWith("/relay/")) return null;
    if (url.pathname === "/rpc/Switch.Set") {
      output = url.searchParams.get("on") === "true";
      return { was_on: !output };
    }
    if (url.pathname === "/rpc/Switch.GetStatus") return { id: 0, output };
    return null;
  });

  const lighting = new HttpLightingController(() => ({
    kind: "shelly",
    host: device.host,
    channel: 0,
  }));

  await lighting.setLight(5, true);
  assert.ok(
    device.calls.some((c) => c.startsWith("/relay/0")),
    "сначала попробовали адрес первого поколения"
  );
  assert.ok(
    device.calls.some((c) => c.includes("Switch.Set") && c.includes("on=true")),
    "потом сработал адрес второго"
  );
  assert.equal(await lighting.readLight(5), true, "состояние читается как у Gen2");

  // Поколение запомнено: лишних запросов к Gen1 больше нет.
  const before = device.calls.length;
  await lighting.setLight(5, false);
  const after = device.calls.slice(before);
  assert.equal(after.length, 1, "одна команда вместо двух");
  assert.match(after[0], /Switch\.Set.*on=false/);
});

test("«Своё устройство»: два своих адреса", async (t) => {
  const device = await fakeDevice(t, () => "OK");
  const lighting = new HttpLightingController(() => ({
    kind: "url",
    on_url: `http://${device.host}/moe-rele/vkl`,
    off_url: `http://${device.host}/moe-rele/vykl`,
  }));

  await lighting.setLight(9, true);
  assert.equal(device.calls.at(-1), "/moe-rele/vkl");
  await lighting.setLight(9, false);
  assert.equal(device.calls.at(-1), "/moe-rele/vykl");
  assert.equal(
    await lighting.readLight(9),
    null,
    "состояние у своего устройства не спрашиваем — адреса для этого нет"
  );
});

test("недоступное реле не роняет кассу", async (t) => {
  forgetShellyGenerations();
  const lighting = new HttpLightingController(() => ({
    kind: "tasmota",
    host: "127.0.0.1:1", // никто не слушает
    channel: 0,
  }));

  await assert.rejects(() => lighting.setLight(1, true), /.+/, "ручное включение честно сообщает об ошибке");
  assert.equal(await lighting.readLight(1), null, "опрос молчит, а не падает");

  // Автоматическое включение при открытии стола не бросает исключений.
  lighting.turnLightOn(1);
  assert.equal(lighting.isLightOn(1), true, "программа считает свет включённым");
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test("незаполненная привязка объясняет, чего не хватает", async (t) => {
  const lighting = new HttpLightingController((id) =>
    id === 1 ? { kind: "tasmota", host: "" } : { kind: "url", on_url: "", off_url: "" }
  );
  await assert.rejects(() => lighting.setLight(1, true), /адрес устройства/i);
  await assert.rejects(() => lighting.setLight(2, true), /адреса включения/i);
});

test("положение привода: Tasmota ShutterPosition, «своё устройство» с {percent}", async (t) => {
  const device = await fakeDevice(t, () => ({ Shutter1: { Position: 50 } }));
  const tasmota = new HttpLightingController(() => ({
    kind: "tasmota",
    host: device.host,
    channel: 0,
  }));
  await tasmota.setPosition(1, 50);
  assert.match(device.calls.at(-1), /\/cm\?cmnd=ShutterPosition1%2050/);

  const custom = new HttpLightingController(() => ({
    kind: "url",
    on_url: `http://${device.host}/set?pos={percent}`,
    off_url: `http://${device.host}/off`,
  }));
  await custom.setPosition(2, 30);
  assert.match(device.calls.at(-1), /\/set\?pos=30/);

  const noSlot = new HttpLightingController(() => ({
    kind: "url",
    on_url: `http://${device.host}/on`,
    off_url: `http://${device.host}/off`,
  }));
  await assert.rejects(noSlot.setPosition(3, 30), /\{percent\}/);
});

test("опрос реле: Tasmota сообщает IP и MAC, Shelly — MAC, молчащее — «нет связи»", async (t) => {
  const device = await fakeDevice(t, (url) => {
    if (url.pathname === "/shelly") return { mac: "3494547A1B2C", type: "SHSW-1" };
    const cmnd = url.searchParams.get("cmnd") ?? "";
    if (/Status 5/i.test(cmnd)) {
      return { StatusNET: { IPAddress: "192.168.1.77", Mac: "A4:CF:12:34:56:78" } };
    }
    return { POWER1: "OFF" };
  });
  const tasmota = new HttpLightingController(() => ({ kind: "tasmota", host: device.host, channel: 0 }));
  assert.deepEqual(await tasmota.probe(1), { online: true, ip: "192.168.1.77", mac: "A4:CF:12:34:56:78" });

  const shelly = new HttpLightingController(() => ({ kind: "shelly", host: device.host, channel: 0 }));
  const info = await shelly.probe(2);
  assert.equal(info.online, true);
  assert.equal(info.mac, "3494547A1B2C");
  assert.equal(info.ip, "127.0.0.1");

  const dead = new HttpLightingController(() => ({ kind: "tasmota", host: "127.0.0.1:1", channel: 0 }));
  assert.deepEqual(await dead.probe(3), { online: false });

  const custom = new HttpLightingController(() => ({ kind: "url", on_url: "http://x/on", off_url: "http://x/off" }));
  assert.deepEqual(await custom.probe(4), { online: null });
});
