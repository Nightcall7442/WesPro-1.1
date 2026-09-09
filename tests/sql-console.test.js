// SQL только для чтения: разрешён SELECT, запрещено всё остальное.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createDatabase } from "../src/db.js";
import { runReadOnlyQuery, describeSchema, MAX_ROWS } from "../src/services/sql-console.js";

const USER = { id: 1, name: "Разработчик" };

/** База в файле: режим «только чтение» требует настоящего файла. */
function fileDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billiards-sql-"));
  const file = path.join(dir, "test.db");
  const db = createDatabase(file);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, file };
}

test("SELECT работает и отдаёт колонки со строками", (t) => {
  const { db, file } = fileDatabase(t);
  db.prepare("INSERT INTO tables (name, status, created_at) VALUES ('Стол 7', 'free', ?)").run(
    new Date().toISOString()
  );

  const result = runReadOnlyQuery(db, USER, "SELECT id, name FROM tables", {
    dbPath: file,
  });
  assert.deepEqual(result.columns, ["id", "name"]);
  assert.equal(result.rows[0].name, "Стол 7");
  assert.equal(result.row_count, 1);
  assert.equal(result.truncated, false);
  assert.ok(typeof result.ms === "number");
});

test("WITH … SELECT тоже разрешён", (t) => {
  const { db, file } = fileDatabase(t);
  const result = runReadOnlyQuery(
    db,
    USER,
    "WITH n(x) AS (SELECT 1) SELECT x * 2 AS two FROM n",
    { dbPath: file }
  );
  assert.equal(result.rows[0].two, 2);
});

test("изменять данные нельзя ни одним способом", (t) => {
  const { db, file } = fileDatabase(t);
  const forbidden = [
    "DELETE FROM tables",
    "UPDATE tables SET name = 'x'",
    "INSERT INTO tables (name) VALUES ('x')",
    "DROP TABLE tables",
    "ALTER TABLE tables ADD COLUMN x TEXT",
    "PRAGMA table_info(tables)",
    "ATTACH DATABASE 'other.db' AS o",
    "VACUUM",
    "SELECT 1; DELETE FROM tables",
  ];
  for (const sql of forbidden) {
    assert.throws(
      () => runReadOnlyQuery(db, USER, sql, { dbPath: file }),
      /запрещ|Только один запрос|Разрешены только SELECT/i,
      `запрос «${sql}» должен быть отклонён`
    );
  }

  // Данные целы.
  const count = db.prepare("SELECT COUNT(*) AS n FROM tables").get().n;
  assert.equal(count, 0);
});

test("много строк обрезается лимитом", (t) => {
  const { db, file } = fileDatabase(t);
  const insert = db.prepare(
    "INSERT INTO tables (name, status, created_at) VALUES (?, 'free', ?)"
  );
  const now = new Date().toISOString();
  for (let i = 0; i < MAX_ROWS + 20; i += 1) insert.run(`Стол ${i}`, now);

  const result = runReadOnlyQuery(db, USER, "SELECT id FROM tables", { dbPath: file });
  assert.equal(result.rows.length, MAX_ROWS, "отдали не больше лимита");
  assert.equal(result.row_count, MAX_ROWS + 20, "но сказали, сколько всего");
  assert.equal(result.truncated, true);
});

test("запрос попадает в журнал — видно, кто что смотрел", (t) => {
  const { db, file } = fileDatabase(t);
  runReadOnlyQuery(db, USER, "SELECT COUNT(*) AS n FROM users", { dbPath: file });
  const entry = db
    .prepare("SELECT message FROM journal_entries ORDER BY id DESC LIMIT 1")
    .get();
  assert.match(entry.message, /Запрос к базе \(только чтение\)/);
  assert.match(entry.message, /Разработчик/);
});

test("подсказка по схеме перечисляет таблицы и колонки", (t) => {
  const { file } = fileDatabase(t);
  const schema = describeSchema(file);
  const tables = schema.map((t) => t.table);
  assert.ok(tables.includes("table_sessions"));
  const sessions = schema.find((t) => t.table === "table_sessions");
  assert.ok(sessions.columns.some((c) => c.startsWith("total_cost_kopecks")));
});

test("пустой и слишком длинный запрос отклоняются", (t) => {
  const { db, file } = fileDatabase(t);
  assert.throws(() => runReadOnlyQuery(db, USER, "   ", { dbPath: file }), /Пустой/);
  assert.throws(
    () => runReadOnlyQuery(db, USER, `SELECT '${"x".repeat(4100)}'`, { dbPath: file }),
    /слишком длинный/
  );
});
