// Запросы к базе только на чтение — для разбора жалоб вида «в отчёте
// 700, а в кассе 600».
//
// Это дверь в данные, поэтому она узкая:
//   • только роль «разработчик» (проверяется в роуте);
//   • только один запрос и только SELECT (или WITH … SELECT);
//   • запрещены точка с запятой, PRAGMA, ATTACH и всё, что меняет данные;
//   • жёсткий лимит строк, даже если LIMIT не написали;
//   • соединение открывается отдельно и в режиме «только чтение», так что
//     запись невозможна физически, а не только по договорённости;
//   • каждый запрос пишется в журнал — видно, кто и что смотрел.

import { DatabaseSync } from "node:sqlite";

import { DATABASE_PATH } from "../config.js";
import { ConflictError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";

/** Максимум строк в ответе: больше в интерфейсе всё равно не прочитать. */
export const MAX_ROWS = 200;

/** Слова, которых в запросе быть не должно ни при каких обстоятельствах. */
const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "replace",
  "attach",
  "detach",
  "pragma",
  "vacuum",
  "reindex",
  "commit",
  "rollback",
  "begin",
  "savepoint",
  "trigger",
];

/**
 * Проверяет и выполняет запрос на чтение.
 *
 * @param {import("node:sqlite").DatabaseSync} db живая база (для журнала)
 * @param {{id: number, name: string}} user
 * @param {string} sql
 * @param {{dbPath?: string}} [options] путь к файлу базы (в тестах свой)
 */
export function runReadOnlyQuery(db, user, sql, { dbPath = DATABASE_PATH } = {}) {
  const text = String(sql ?? "").trim().replace(/;\s*$/, "");
  if (!text) throw new ConflictError("Пустой запрос");
  if (text.length > 4000) throw new ConflictError("Запрос слишком длинный");
  if (text.includes(";")) {
    throw new ConflictError("Только один запрос за раз — точка с запятой запрещена");
  }

  const lower = text.toLowerCase();
  if (!/^\s*(select|with)\b/.test(lower)) {
    throw new ConflictError("Разрешены только SELECT и WITH … SELECT");
  }
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) {
      throw new ConflictError(`Слово «${word}» здесь запрещено — это только чтение`);
    }
  }

  // Отдельное соединение в режиме «только чтение»: даже если проверки
  // выше обойти, SQLite физически не даст ничего записать.
  let readOnly;
  try {
    readOnly = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new ConflictError(
      `Не удалось открыть базу только для чтения: ${error.message}`
    );
  }
  const started = Date.now();
  try {
    const statement = readOnly.prepare(text);
    const rows = statement.all();
    const truncated = rows.length > MAX_ROWS;
    const result = {
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows: rows.slice(0, MAX_ROWS),
      row_count: rows.length,
      truncated,
      ms: Date.now() - started,
    };
    logEvent(
      db,
      JournalEvent.SETTINGS_UPDATED,
      `Запрос к базе (только чтение): ${text.slice(0, 200)} — ` +
        `строк ${rows.length}, ${user.name}`
    );
    return result;
  } catch (error) {
    throw new ConflictError(`База не приняла запрос: ${error.message}`);
  } finally {
    readOnly.close();
  }
}

/** Список таблиц и колонок — подсказка, чтобы не вспоминать имена. */
export function describeSchema(dbPath = DATABASE_PATH) {
  const readOnly = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = readOnly
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all()
      .map((r) => r.name);
    return tables.map((name) => ({
      table: name,
      columns: readOnly
        .prepare(`SELECT name, type FROM pragma_table_info(?)`)
        .all(name)
        .map((c) => `${c.name} ${c.type}`),
    }));
  } finally {
    readOnly.close();
  }
}
