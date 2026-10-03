// Архив программы для переноса на компьютер клуба: в нём всё, чтобы
// запустить start-club.bat, и ничего из данных клуба.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";

import { ROOT_DIR } from "../src/config.js";
import { adminAgent, cashierAgent, makeApp } from "./helpers.js";

/** Читает оглавление ZIP и умеет достать файл — проверяем сам формат. */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "есть конец архива");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const body = buf.subarray(start, start + size);
      const data = method === 8 ? zlib.inflateRawSync(body) : body;
      assert.equal(zlib.crc32(data), crc, `${name}: контрольная сумма`);
      return data;
    });
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return files;
}

test("архив программы: батники, код и библиотеки — без данных клуба", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const res = await admin
    .get("/api/download/wespro-club.zip")
    .buffer(true)
    .parse((r, done) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => done(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/zip");
  assert.match(res.headers["content-disposition"], /wespro-club\.zip/);

  const files = readZip(res.body);
  const names = [...files.keys()];
  for (const name of [
    "wespro-club/start-club.bat",
    "wespro-club/firewall-setup.bat",
    "wespro-club/package.json",
    "wespro-club/src/server.js",
    "wespro-club/public/app.js",
    "wespro-club/node_modules/express/package.json",
    "wespro-club/node_modules/tuyapi/index.js",
    "wespro-club/node_modules/.package-lock.json",
  ]) {
    assert.ok(names.includes(name), `в архиве есть ${name}`);
  }
  for (const pattern of [/billiards\.db/, /hub\.db/, /\/\.env$/, /\/logs\//, /\/backups\//, /\/data\//,
    /\/tests\//, /\/\.git\//, /node_modules\/(supertest|esbuild|postject)\//]) {
    assert.ok(!names.some((n) => pattern.test(n)), `в архиве нет ${pattern}`);
  }
  // Батник — байт в байт (кодировка консоли Windows и CRLF сохранены).
  assert.deepEqual(
    files.get("wespro-club/start-club.bat")(),
    fs.readFileSync(path.join(ROOT_DIR, "start-club.bat"))
  );
  assert.deepEqual(
    files.get("wespro-club/src/server.js")(),
    fs.readFileSync(path.join(ROOT_DIR, "src", "server.js"))
  );

  const cashier = await cashierAgent(app, db);
  assert.equal((await cashier.get("/api/download/wespro-club.zip")).status, 403);
});
