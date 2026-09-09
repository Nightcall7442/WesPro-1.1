// Автоматическая резервная копия: файл появляется, старые чистятся,
// копия действительно открывается как база.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { adminAgent, createTable, developerAgent, makeApp } from "./helpers.js";

/** Свежая пустая папка для копий на время теста. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "billiards-backups-"));
}

test("копия базы создаётся и открывается как база", async (t) => {
  const dir = tempDir();
  process.env.BILLIARDS_BACKUP_DIR = dir;
  t.after(() => {
    delete process.env.BILLIARDS_BACKUP_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Модуль читает папку при загрузке, поэтому импортируем после env.
  const { makeBackupNow, listBackups } = await import(
    "../src/services/auto-backup.js"
  );

  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  await createTable(admin, "Стол у окна");

  const made = makeBackupNow(db);
  assert.ok(fs.existsSync(made.file), "файл копии на месте");
  assert.match(made.name, /^billiards-\d{4}-\d{2}-\d{2}\.db$/);
  assert.equal(listBackups().length, 1);

  // В копии действительно наши данные.
  const copy = new DatabaseSync(made.file, { readOnly: true });
  const table = copy.prepare("SELECT name FROM tables").get();
  copy.close();
  assert.equal(table.name, "Стол у окна");
});

test("копий хранится не больше заданного числа", async (t) => {
  const dir = tempDir();
  process.env.BILLIARDS_BACKUP_DIR = dir;
  process.env.BILLIARDS_BACKUP_KEEP = "3";
  t.after(() => {
    delete process.env.BILLIARDS_BACKUP_DIR;
    delete process.env.BILLIARDS_BACKUP_KEEP;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { makeBackupNow, listBackups } = await import(
    "../src/services/auto-backup.js"
  );

  const { db } = makeApp();
  // Пять «вчерашних» копий разных дней + сегодняшняя.
  for (const day of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05"]) {
    fs.writeFileSync(path.join(dir, `billiards-${day}.db`), "старая копия");
  }
  assert.equal(listBackups().length, 5);

  makeBackupNow(db);
  const left = listBackups();
  assert.equal(left.length, 3, "лишние копии удалены");
  assert.match(left[0].name, /^billiards-2\d{3}-/, "самая свежая — сегодняшняя");
  assert.ok(
    !left.some((b) => b.name === "billiards-2020-01-01.db"),
    "самая старая удалена первой"
  );
});

test("повторная копия за тот же день перезаписывает файл", async (t) => {
  const dir = tempDir();
  process.env.BILLIARDS_BACKUP_DIR = dir;
  t.after(() => {
    delete process.env.BILLIARDS_BACKUP_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { makeBackupNow, listBackups } = await import(
    "../src/services/auto-backup.js"
  );

  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  makeBackupNow(db);
  await createTable(admin, "Стол добавлен позже");
  const second = makeBackupNow(db);

  assert.equal(listBackups().length, 1, "за день — одна копия");
  const copy = new DatabaseSync(second.file, { readOnly: true });
  const names = copy.prepare("SELECT name FROM tables").all().map((r) => r.name);
  copy.close();
  assert.ok(names.includes("Стол добавлен позже"), "копия свежая");
});

test("диагностика показывает копии, кнопка делает копию сейчас", async (t) => {
  const dir = tempDir();
  process.env.BILLIARDS_BACKUP_DIR = dir;
  t.after(() => {
    delete process.env.BILLIARDS_BACKUP_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const { db, app } = makeApp();
  const admin = await adminAgent(app);

  const made = await admin.post("/api/backup/now");
  assert.equal(made.status, 201);
  assert.ok(made.body.name);

  // Разработчика заводим только теперь: до этого у первого сотрудника
  // ещё действует временная бесхозная роль (первый запуск), которую
  // и проверяет POST /api/backup/now выше.
  const dev = await developerAgent(app, db);
  const diag = await dev.get("/api/diagnostics");
  assert.equal(diag.status, 200);
  assert.ok(diag.body.backups, "в диагностике есть раздел копий");
  assert.equal(diag.body.backups.files.length, 1);
  assert.equal(diag.body.backups.files[0].name, made.body.name);
});
