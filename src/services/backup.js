// Резервная копия базы: выгрузка файла и загрузка своего файла обратно.
//
// Экспорт — VACUUM INTO: получается компактный самостоятельный файл SQLite
// (все столы, тарифы, история, клиенты, настройки, сотрудники).
//
// Импорт нельзя сделать «положить файл на место старого»: сервер уже держит
// открытое соединение с текущей базой (и WAL-файлы к ней). Поэтому файл
// подключается через ATTACH и данные переливаются таблица за таблицей в
// живую базу. Копируются только колонки, которые есть в обеих схемах, —
// значит копия из более старой версии программы тоже загрузится, а новые
// поля просто останутся со значениями по умолчанию.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { utcNow, withTransaction } from "../db.js";
import { ConflictError } from "./errors.js";

// Порядок важен: сначала таблицы, на которые ссылаются остальные.
const IMPORT_ORDER = [
  "settings",
  "users",
  "tables",
  "tariffs",
  "tariff_rules",
  "table_tariffs",
  "role_permissions",
  "user_permissions",
  "clients",
  "menu_items",
  "shifts",
  "cash_movements",
  "vouchers",
  "table_sessions",
  "session_orders",
  "bookings",
  "plan_elements",
  "journal_entries",
];

// auth_sessions не переносим: токены из чужой базы всё равно ничьи, а
// текущие входы после подмены пользователей недействительны — их чистим.

/**
 * Пишет компактную копию базы во временный файл и возвращает его путь.
 * Вызывающий обязан удалить файл после отдачи клиенту.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function exportBackupFile(db) {
  const target = path.join(os.tmpdir(), `billiards-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

/** Имя файла копии для пользователя: с датой, чтобы копии не путались. */
export function backupFileName() {
  return `billiards-backup-${utcNow().slice(0, 10)}.db`;
}

/** Проверяет, что файл — действительно база этой программы. */
function assertLooksLikeOurDatabase(filePath) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.toString("latin1", 0, 15) !== "SQLite format 3") {
    throw new ConflictError("Это не файл базы данных SQLite (.db)");
  }
  // Файл может быть недокачан или повреждён: SQLite открывает его без
  // жалоб, а спотыкается на первом же запросе. Такие ошибки переводим в
  // понятное сообщение, а свои проверки (ConflictError) пропускаем как есть.
  const probe = new DatabaseSync(filePath, { readOnly: true });
  try {
    const names = new Set(
      probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
    );
    for (const required of ["users", "tables", "tariffs", "table_sessions"]) {
      if (!names.has(required)) {
        throw new ConflictError(
          "В файле нет таблиц бильярдного клуба — похоже, это база от другой программы"
        );
      }
    }
    const admins = probe
      .prepare(
        `SELECT COUNT(*) AS n FROM users
         WHERE is_active = 1 AND role IN ('developer', 'owner', 'manager', 'admin')`
      )
      .get().n;
    if (!admins) {
      throw new ConflictError(
        "В копии нет ни одного активного управленческого аккаунта — войти после загрузки будет некому"
      );
    }
    return names;
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw new ConflictError(
      "Файл повреждён или скопирован не полностью — возьмите копию заново"
    );
  } finally {
    probe.close();
  }
}

function columnsOf(db, table, schema = "main") {
  return db
    .prepare("SELECT name FROM pragma_table_info(?, ?)")
    .all(table, schema)
    .map((r) => r.name);
}

/**
 * Загружает базу из файла копии, заменяя текущие данные.
 * @param {import("node:sqlite").DatabaseSync} db живая база
 * @param {string} filePath путь к загруженному файлу .db
 * @returns {{tables: string[], skipped: string[]}}
 */
export function importBackupFile(db, filePath) {
  const sourceTables = assertLooksLikeOurDatabase(filePath);

  const copied = [];
  const skipped = [];
  // Внешние ключи выключаем на время переливки: пока таблицы пустеют и
  // наполняются, ссылки между ними на короткое время не сходятся.
  // (PRAGMA нельзя менять внутри транзакции, поэтому — снаружи.)
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`ATTACH DATABASE '${filePath.replace(/'/g, "''")}' AS backup_src`);
    try {
      withTransaction(db, () => {
        // Чистим в обратном порядке — сначала зависимые таблицы.
        for (const table of [...IMPORT_ORDER].reverse()) {
          db.exec(`DELETE FROM main.${table}`);
        }
        db.exec("DELETE FROM main.auth_sessions");

        for (const table of IMPORT_ORDER) {
          if (!sourceTables.has(table)) {
            skipped.push(table); // в старой копии такой таблицы ещё не было
            continue;
          }
          const shared = columnsOf(db, table).filter((column) =>
            columnsOf(db, table, "backup_src").includes(column)
          );
          if (!shared.length) {
            skipped.push(table);
            continue;
          }
          const list = shared.map((c) => `"${c}"`).join(", ");
          db.exec(
            `INSERT INTO main.${table} (${list}) SELECT ${list} FROM backup_src.${table}`
          );
          copied.push(table);
        }
      });
    } finally {
      db.exec("DETACH DATABASE backup_src");
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return { tables: copied, skipped };
}
