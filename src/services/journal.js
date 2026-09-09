// Запись событий в журнал. Единственная точка записи: все сервисы
// фиксируют события через logEvent, поэтому формат записей единообразен.

import { utcNow } from "../db.js";

export const JournalEvent = Object.freeze({
  TABLE_CREATED: "table_created",
  TABLE_DELETED: "table_deleted",
  TARIFF_CREATED: "tariff_created",
  TARIFF_UPDATED: "tariff_updated",
  TARIFF_DELETED: "tariff_deleted",
  SESSION_OPENED: "session_opened",
  SESSION_CLOSED: "session_closed",
  LIGHT_ON: "light_on",
  LIGHT_OFF: "light_off",
  SHIFT_OPENED: "shift_opened",
  SHIFT_CLOSED: "shift_closed",
  CASH_MOVEMENT: "cash_movement",
  USER_CREATED: "user_created",
  USER_UPDATED: "user_updated",
  USER_DELETED: "user_deleted",
  BACKUP_RESTORED: "backup_restored",
  SETTINGS_UPDATED: "settings_updated",
  BOOKING_CREATED: "booking_created",
  BOOKING_CANCELLED: "booking_cancelled",
  CLIENT_CREATED: "client_created",
  CLIENT_TOPUP: "client_topup",
  CLIENT_DEBIT: "client_debit",
});

/**
 * Добавляет запись в журнал.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} event значение из JournalEvent
 * @param {string} message человекочитаемое описание
 * @param {{tableId?: number, sessionId?: number}} [refs]
 */
export function logEvent(db, event, message, refs = {}) {
  db.prepare(
    `INSERT INTO journal_entries (event, message, table_id, session_id, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(event, message, refs.tableId ?? null, refs.sessionId ?? null, utcNow());
}

/**
 * Последние записи журнала, новые сверху.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} [limit]
 */
export function listJournal(db, limit = 200) {
  return db
    .prepare(
      `SELECT id, event, message, table_id, session_id, created_at
       FROM journal_entries
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(limit);
}
