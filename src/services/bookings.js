// Бронирование столов: запись на время вперёд с проверкой пересечений.
// На дашборде стол подсвечивается, когда до брони остаётся мало времени.

import { utcNow } from "../db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";
import { getTable } from "./tables.js";

const BOOKING_FIELDS = `
  b.id, b.table_id, t.name AS table_name, b.client_name, b.phone,
  b.starts_at, b.duration_minutes, b.note, b.status, b.created_at,
  u.name AS created_by_name
`;

const BOOKING_JOIN = `
  FROM bookings b
  JOIN tables t ON t.id = b.table_id
  LEFT JOIN users u ON u.id = b.created_by
`;

function endsAtIso(booking) {
  return new Date(
    Date.parse(booking.starts_at) + booking.duration_minutes * 60000
  ).toISOString();
}

export function getBooking(db, bookingId) {
  const booking = db
    .prepare(`SELECT ${BOOKING_FIELDS} ${BOOKING_JOIN} WHERE b.id = ?`)
    .get(bookingId);
  if (!booking) throw new NotFoundError(`Бронь id=${bookingId} не найдена`);
  return booking;
}

/**
 * Актуальные брони (ещё не завершившиеся), ближайшие сверху.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function listBookings(db, { limit = 200 } = {}) {
  const now = utcNow();
  return db
    .prepare(
      `SELECT ${BOOKING_FIELDS} ${BOOKING_JOIN}
       WHERE b.status = 'active'
         AND julianday(b.starts_at) + b.duration_minutes / 1440.0 > julianday(?)
       ORDER BY b.starts_at LIMIT ?`
    )
    .all(now, limit);
}

/**
 * Ближайшая активная бронь стола (для подсветки на дашборде).
 * @returns бронь или undefined
 */
export function nextBookingForTable(db, tableId, horizonHours = 24) {
  const now = utcNow();
  const horizon = new Date(
    Date.parse(now) + horizonHours * 3600 * 1000
  ).toISOString();
  return db
    .prepare(
      `SELECT ${BOOKING_FIELDS} ${BOOKING_JOIN}
       WHERE b.table_id = ? AND b.status = 'active'
         AND julianday(b.starts_at) + b.duration_minutes / 1440.0 > julianday(?)
         AND b.starts_at < ?
       ORDER BY b.starts_at LIMIT 1`
    )
    .get(tableId, now, horizon);
}

/**
 * Создаёт бронь с проверкой пересечения с другими бронями этого стола.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{table_id: number, client_name: string, phone?: string,
 *          starts_at: string, duration_minutes: number, note?: string}} data
 * @param {{id: number, name: string}} user
 */
export function createBooking(db, data, user) {
  const table = getTable(db, Number(data.table_id));
  const clientName = String(data.client_name ?? "").trim();
  if (!clientName) throw new ConflictError("Укажите имя клиента");

  const startsMs = Date.parse(data.starts_at);
  if (Number.isNaN(startsMs)) throw new ConflictError("Некорректное время начала");
  const startsAt = new Date(startsMs).toISOString();
  if (startsAt <= utcNow()) {
    throw new ConflictError("Время брони должно быть в будущем");
  }
  const duration = Number(data.duration_minutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 24 * 60) {
    throw new ConflictError("Длительность брони: от 15 минут до 24 часов");
  }
  const endsAt = new Date(startsMs + duration * 60000).toISOString();

  const overlap = db
    .prepare(
      `SELECT b.id, b.client_name, b.starts_at FROM bookings b
       WHERE b.table_id = ? AND b.status = 'active'
         AND b.starts_at < ?
         AND julianday(b.starts_at) + b.duration_minutes / 1440.0 > julianday(?)
       LIMIT 1`
    )
    .get(table.id, endsAt, startsAt);
  if (overlap) {
    throw new ConflictError(
      `Пересечение с бронью «${overlap.client_name}» на этом столе`
    );
  }

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO bookings
         (table_id, client_name, phone, starts_at, duration_minutes, note,
          status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .run(
      table.id,
      clientName,
      String(data.phone ?? "").trim() || null,
      startsAt,
      duration,
      String(data.note ?? "").trim() || null,
      user.id,
      utcNow()
    );
  const booking = getBooking(db, Number(lastInsertRowid));
  logEvent(
    db,
    JournalEvent.BOOKING_CREATED,
    `Бронь стола «${table.name}» для «${clientName}» — ${user.name}`,
    { tableId: table.id }
  );
  return booking;
}

/** Отменяет бронь. */
export function cancelBooking(db, bookingId, user) {
  const booking = getBooking(db, bookingId);
  if (booking.status !== "active") {
    throw new ConflictError("Бронь уже отменена");
  }
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
  logEvent(
    db,
    JournalEvent.BOOKING_CANCELLED,
    `Отменена бронь стола «${booking.table_name}» для «${booking.client_name}» — ${user.name}`,
    { tableId: booking.table_id }
  );
  return getBooking(db, booking.id);
}

export { endsAtIso };
