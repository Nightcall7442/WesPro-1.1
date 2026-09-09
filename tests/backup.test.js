// Резервная копия: выгрузка файла и загрузка его обратно.
// Проверяем главное — данные из копии действительно заменяют текущие,
// мусорный файл отвергается, а права на загрузку есть только у владельца.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";

import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { exportBackupFile, importBackupFile } from "../src/services/backup.js";
import { createTariff } from "../src/services/tariffs.js";
import { createTable } from "../src/services/tables.js";
import { createUser } from "../src/services/users.js";
import { saveSettings } from "../src/services/settings.js";
import { adminAgent, cashierAgent, makeApp } from "./helpers.js";

/** База «как у клуба»: владелец, столы, тариф, название клуба. */
function makeSourceDatabase(file) {
  const db = createDatabase(file);
  createUser(db, {
    login: "owner",
    name: "Владелец из копии",
    password: "owner1",
    role: "owner",
  });
  createTable(db, "Стол из копии");
  createTariff(db, "Тариф из копии", 777);
  saveSettings(db, { club_name: "Клуб из копии" });
  return db;
}

test("экспорт даёт самостоятельный файл SQLite с данными", () => {
  const { db } = makeApp();
  createTable(db, "Стол для копии");
  const file = exportBackupFile(db);
  try {
    assert.ok(fs.statSync(file).size > 0, "файл копии не пустой");
    const copy = new DatabaseSync(file, { readOnly: true });
    const names = copy.prepare("SELECT name FROM tables").all().map((r) => r.name);
    copy.close();
    assert.ok(names.includes("Стол для копии"));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("импорт заменяет данные живой базы данными из копии", () => {
  const sourceFile = path.join(os.tmpdir(), `backup-src-${Date.now()}.db`);
  const source = makeSourceDatabase(sourceFile);
  const exported = exportBackupFile(source);
  source.close();

  const live = createDatabase(":memory:");
  createUser(live, { login: "admin", name: "Старый админ", password: "admin1", role: "admin" });
  createTable(live, "Старый стол");

  try {
    const result = importBackupFile(live, exported);
    assert.ok(result.tables.includes("tables"), "таблицы перелились");

    const tables = live.prepare("SELECT name FROM tables").all().map((r) => r.name);
    assert.deepEqual(tables, ["Стол из копии"], "старые столы заменены");

    const users = live.prepare("SELECT login FROM users").all().map((r) => r.login);
    assert.deepEqual(users, ["owner"], "сотрудники тоже из копии");

    const clubName = live
      .prepare("SELECT value FROM settings WHERE key = 'club_name'")
      .get().value;
    assert.equal(clubName, "Клуб из копии");

    // Токены входа не переносятся: после подмены пользователей они не ничьи.
    assert.equal(live.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 0);

    // База осталась рабочей: новый стол добавляется.
    createTable(live, "Стол после импорта");
    assert.equal(live.prepare("SELECT COUNT(*) AS n FROM tables").get().n, 2);
  } finally {
    fs.rmSync(exported, { force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${sourceFile}${suffix}`, { force: true });
    }
  }
});

test("импорт копии из старой версии базы: не хватает колонок — не беда", () => {
  // Копия «прошлой версии»: у столов нет kind/is_active и нет таблицы
  // table_tariffs. Такой файл всё равно должен загрузиться.
  const file = path.join(os.tmpdir(), `backup-old-${Date.now()}.db`);
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL);
    CREATE TABLE tariffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      price_per_hour INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL);
    CREATE TABLE table_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL,
      tariff_id INTEGER NOT NULL, price_per_hour_snapshot INTEGER NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, total_cost_kopecks INTEGER);
  `);
  const now = new Date().toISOString();
  old.prepare(
    "INSERT INTO users (login, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
  ).run("owner", "Владелец", "hash:hash", "owner", now);
  old.prepare("INSERT INTO tables (name, created_at) VALUES (?, ?)").run("Старый стол", now);
  old.close();

  const live = createDatabase(":memory:");
  createUser(live, { login: "admin", name: "Админ", password: "admin1", role: "admin" });
  try {
    const result = importBackupFile(live, file);
    const row = live.prepare("SELECT name, kind, is_active FROM tables").get();
    assert.equal(row.name, "Старый стол");
    assert.equal(row.kind, "billiard", "новая колонка получила значение по умолчанию");
    assert.equal(row.is_active, 1);
    assert.ok(result.skipped.includes("table_tariffs"), "отсутствующая таблица пропущена");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("посторонний файл не принимается", () => {
  const file = path.join(os.tmpdir(), `not-a-db-${Date.now()}.txt`);
  fs.writeFileSync(file, "просто текст, а не база");
  const live = createDatabase(":memory:");
  try {
    assert.throws(() => importBackupFile(live, file), /SQLite/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("база от другой программы не принимается", () => {
  const file = path.join(os.tmpdir(), `alien-${Date.now()}.db`);
  const alien = new DatabaseSync(file);
  alien.exec("CREATE TABLE cats (id INTEGER PRIMARY KEY, name TEXT)");
  alien.close();
  const live = createDatabase(":memory:");
  try {
    assert.throws(() => importBackupFile(live, file), /другой программы/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("копию без активного управленца не принимаем — входить будет некому", () => {
  const file = path.join(os.tmpdir(), `noadmin-${Date.now()}.db`);
  const source = createDatabase(file);
  createUser(source, { login: "kassa", name: "Кассир", password: "1234", role: "cashier" });
  const exported = exportBackupFile(source);
  source.close();

  const live = createDatabase(":memory:");
  try {
    assert.throws(() => importBackupFile(live, exported), /управленческого аккаунта/);
  } finally {
    fs.rmSync(exported, { force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${file}${suffix}`, { force: true });
    }
  }
});

test("загружать копию по API может только владелец", async () => {
  const { app, db } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const payload = Buffer.from("SQLite format 3\0");
  const send = (agent) =>
    agent
      .post("/api/backup/import")
      .set("Content-Type", "application/octet-stream")
      .send(payload);

  // Кассиру закрыто всегда.
  assert.equal((await send(cashier)).status, 403);

  // Пока владельца в системе нет, загрузку делает администратор —
  // иначе на свежей установке восстановиться было бы некому.
  // (Файл тут заведомо битый, поэтому 409 — значит проверка прав пройдена.)
  assert.equal((await send(admin)).status, 409, "администратор допущен до проверки файла");

  // Появился владелец — администратор больше не допускается.
  await admin.post("/api/users").send({
    login: "owner", name: "Владелец", password: "owner1", role: "owner",
  });
  assert.equal((await send(admin)).status, 403, "теперь только владелец");

  const owner = supertest.agent(app);
  await owner.post("/api/auth/login").send({ login: "owner", password: "owner1" });
  const bad = await send(owner);
  assert.equal(bad.status, 409, "битый файл — понятная ошибка, а не 500");
  assert.match(bad.body.detail, /повреждён|SQLite/);
});

test("экспорт базы по API отдаёт файл", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const res = await admin.get("/api/backup");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-disposition"], /billiards-backup-\d{4}-\d{2}-\d{2}\.db/);
  assert.equal(res.body.subarray(0, 15).toString("latin1"), "SQLite format 3");
});

test("живая база после импорта через API работает", async () => {
  // Готовим копию клуба и грузим её владельцу поверх текущей базы.
  const sourceFile = path.join(os.tmpdir(), `api-import-${Date.now()}.db`);
  const source = makeSourceDatabase(sourceFile);
  const exported = exportBackupFile(source);
  source.close();

  const db = createDatabase(":memory:");
  createUser(db, { login: "admin", name: "Админ", password: "admin1", role: "admin" });
  createUser(db, { login: "boss", name: "Хозяин", password: "boss12", role: "owner" });
  const app = createApp(db);
  const owner = supertest.agent(app);
  await owner.post("/api/auth/login").send({ login: "boss", password: "boss12" });

  try {
    const res = await owner
      .post("/api/backup/import")
      .set("Content-Type", "application/octet-stream")
      .send(fs.readFileSync(exported));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    // Токен старого владельца больше не действует — все входы сброшены.
    assert.equal((await owner.get("/api/auth/me")).status, 401);

    // Зато логин из копии работает, и в базе — данные копии.
    const fromCopy = supertest.agent(app);
    const login = await fromCopy
      .post("/api/auth/login")
      .send({ login: "owner", password: "owner1" });
    assert.equal(login.status, 200);
    assert.equal(login.body.club_name, "Клуб из копии");
    const tables = (await fromCopy.get("/api/tables")).body.map((t) => t.name);
    assert.deepEqual(tables, ["Стол из копии"]);
  } finally {
    fs.rmSync(exported, { force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${sourceFile}${suffix}`, { force: true });
    }
  }
});
