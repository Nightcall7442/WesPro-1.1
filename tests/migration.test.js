// Регресс-тест на миграцию ролей: реальные базы, созданные до появления
// developer/owner, содержат users.role с CHECK IN ('admin','cashier').
// createDatabase должен пересобрать эту таблицу на лету, не потеряв данные
// и не сломав внешние ключи из других таблиц (shifts.user_id и т.п.).

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDatabase } from "../src/db.js";

/**
 * Убирает файл базы после теста. Открытую базу Windows удалить не даёт
 * (EPERM), поэтому сначала закрываем всё, что открывали.
 */
function cleanup(file, dbs) {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // уже закрыта
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

test("миграция ролей: старая база (admin/cashier) обновляется без потери данных", () => {
  const file = path.join(os.tmpdir(), `migration-test-${Date.now()}.db`);
  const opened = [];
  try {
    // Имитируем базу в старом формате: users с прежним CHECK + связанная
    // смена, ссылающаяся на пользователя (как в реальных установках).
    const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    raw.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        login         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE shifts (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        opened_at TEXT NOT NULL,
        closed_at TEXT
      );
    `);
    raw.prepare(
      "INSERT INTO users (login, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run("admin", "Старый админ", "hash:hash", "admin", new Date().toISOString());
    raw.prepare(
      "INSERT INTO shifts (user_id, opened_at) VALUES (1, ?)"
    ).run(new Date().toISOString());
    raw.close();

    // createDatabase должна доехать без исключений и сама пересобрать users.
    const db = createDatabase(file);
    opened.push(db);

    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'users'")
      .get().sql;
    assert.match(schema, /'developer'/);
    assert.match(schema, /'owner'/);

    // Старые данные не потерялись.
    const user = db.prepare("SELECT * FROM users WHERE login = 'admin'").get();
    assert.equal(user.name, "Старый админ");
    assert.equal(user.role, "admin");

    // Внешний ключ из shifts на users пережил пересборку таблицы.
    const shift = db.prepare("SELECT * FROM shifts WHERE id = 1").get();
    assert.equal(shift.user_id, user.id);

    // Новые роли теперь допустимы.
    db.prepare(
      "INSERT INTO users (login, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run("owner1", "Владелец", "hash:hash", "owner", new Date().toISOString());
    const owner = db.prepare("SELECT * FROM users WHERE login = 'owner1'").get();
    assert.equal(owner.role, "owner");

    // Повторный вызов createDatabase на уже смигрированной базе — no-op.
    assert.doesNotThrow(() => opened.push(createDatabase(file)));
  } finally {
    cleanup(file, opened);
  }
});

test("миграция plan_elements: старая база (только wall/door) принимает мебель", () => {
  const file = path.join(os.tmpdir(), `migration-plan-test-${Date.now()}.db`);
  const opened = [];
  try {
    // Имитируем базу до появления мебели в редакторе зала.
    const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    raw.exec(`
      CREATE TABLE plan_elements (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT NOT NULL CHECK (type IN ('wall', 'door')),
        x          INTEGER NOT NULL,
        y          INTEGER NOT NULL,
        w          INTEGER NOT NULL CHECK (w > 0),
        h          INTEGER NOT NULL CHECK (h > 0),
        created_at TEXT NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO plan_elements (type, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("wall", 1, 1, 5, 1, new Date().toISOString());
    raw.close();

    const db = createDatabase(file);
    opened.push(db);

    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'plan_elements'")
      .get().sql;
    assert.match(schema, /'sofa'/);

    // Старая стена не потерялась.
    const wall = db.prepare("SELECT * FROM plan_elements WHERE type = 'wall'").get();
    assert.equal(wall.x, 1);

    // Мебель теперь можно сохранить (раньше падало с CHECK constraint failed).
    assert.doesNotThrow(() =>
      db
        .prepare(
          "INSERT INTO plan_elements (type, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("sofa", 2, 2, 3, 1, new Date().toISOString())
    );

    assert.doesNotThrow(() => opened.push(createDatabase(file)));
  } finally {
    cleanup(file, opened);
  }
});

test("миграция ролей: база с developer/owner дополняется ролью manager", () => {
  const file = path.join(os.tmpdir(), `migration-manager-${Date.now()}.db`);
  const opened = [];
  try {
    // База предыдущей версии: роли уже расширены до developer/owner,
    // но управляющего (manager) в CHECK ещё нет.
    const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    raw.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        login         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('developer', 'owner', 'admin', 'cashier')),
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO users (login, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run("owner", "Владелец", "hash:hash", "owner", new Date().toISOString());
    raw.close();

    const db = createDatabase(file);
    opened.push(db);
    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'users'")
      .get().sql;
    assert.match(schema, /'manager'/);

    // Данные целы, и новая роль принимается.
    assert.equal(db.prepare("SELECT name FROM users WHERE login = 'owner'").get().name, "Владелец");
    db.prepare(
      "INSERT INTO users (login, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run("upravl", "Управляющий", "hash:hash", "manager", new Date().toISOString());
    assert.equal(
      db.prepare("SELECT role FROM users WHERE login = 'upravl'").get().role,
      "manager"
    );

    // Повторный вызов — no-op.
    assert.doesNotThrow(() => opened.push(createDatabase(file)));
  } finally {
    cleanup(file, opened);
  }
});
