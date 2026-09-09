// Кассовые смены с пересдачей кассы. Кассир открывает смену (указав
// наличные в кассе на начало), работает, закрывает (указав фактические
// наличные) — система считает расчётные наличные и расхождение.
// Выручка сеанса привязывается к смене того, кто его закрыл.

import { utcNow } from "../db.js";
import { kopecksToRubles, rublesToKopecks } from "./billing.js";
import { ConflictError } from "./errors.js";
import { getClubSettings } from "./settings.js";
import { JournalEvent, logEvent } from "./journal.js";

const SHIFT_TOTALS = `
  (SELECT COUNT(*) FROM table_sessions ts WHERE ts.close_shift_id = sh.id)
    AS sessions_count,
  (SELECT COALESCE(SUM(ts.total_cost_kopecks), 0) FROM table_sessions ts
    WHERE ts.close_shift_id = sh.id) AS revenue_kopecks,
  (SELECT COALESCE(SUM(ts.total_cost_kopecks - ts.account_kopecks), 0) FROM table_sessions ts
    WHERE ts.close_shift_id = sh.id AND ts.payment_method = 'cash')
    AS cash_kopecks,
  (SELECT COALESCE(SUM(ts.total_cost_kopecks - ts.account_kopecks), 0) FROM table_sessions ts
    WHERE ts.close_shift_id = sh.id AND ts.payment_method = 'card')
    AS card_kopecks,
  (SELECT COALESCE(SUM(ts.total_cost_kopecks - ts.account_kopecks), 0) FROM table_sessions ts
    WHERE ts.close_shift_id = sh.id AND ts.payment_method = 'transfer')
    AS transfer_kopecks,
  (SELECT COALESCE(SUM(ts.account_kopecks), 0) FROM table_sessions ts
    WHERE ts.close_shift_id = sh.id) AS account_kopecks,
  (SELECT COALESCE(SUM(cm.amount_kopecks), 0) FROM cash_movements cm
    WHERE cm.shift_id = sh.id AND cm.kind = 'in') AS cash_in_kopecks,
  (SELECT COALESCE(SUM(cm.amount_kopecks), 0) FROM cash_movements cm
    WHERE cm.shift_id = sh.id AND cm.kind = 'out') AS cash_out_kopecks
`;

function toShiftOut(row) {
  const openingCash =
    row.opening_cash_kopecks === null ? null : kopecksToRubles(row.opening_cash_kopecks);
  const closingCash =
    row.closing_cash_kopecks === null ? null : kopecksToRubles(row.closing_cash_kopecks);
  // Расчётные наличные в кассе: остаток на начало + наличная выручка
  // + внесения − выдачи из кассы. Без последних двух слагаемых касса
  // «не сходилась» каждый раз, когда днём брали деньги на закупку.
  const expectedCash =
    openingCash === null
      ? null
      : kopecksToRubles(
          row.opening_cash_kopecks +
            row.cash_kopecks +
            (row.cash_in_kopecks ?? 0) -
            (row.cash_out_kopecks ?? 0)
        );
  return {
    id: row.id,
    user_id: row.user_id,
    user_name: row.user_name,
    opened_at: row.opened_at,
    closed_at: row.closed_at ?? null,
    sessions_count: row.sessions_count,
    revenue: kopecksToRubles(row.revenue_kopecks),
    cash: kopecksToRubles(row.cash_kopecks),
    card: kopecksToRubles(row.card_kopecks),
    transfer: kopecksToRubles(row.transfer_kopecks),
    // Оплачено со счетов клиентов: выручка есть, а денег в кассу сейчас
    // не приходило — они пришли раньше, при пополнении.
    account: kopecksToRubles(row.account_kopecks ?? 0),
    cash_in: kopecksToRubles(row.cash_in_kopecks ?? 0),
    cash_out: kopecksToRubles(row.cash_out_kopecks ?? 0),
    opening_cash: openingCash,
    closing_cash: closingCash,
    expected_cash: expectedCash,
    // Расхождение: сдано минус расчёт (минус — недостача).
    cash_discrepancy:
      expectedCash === null || closingCash === null
        ? null
        : Math.round((closingCash - expectedCash) * 100) / 100,
  };
}

function getShiftRow(db, shiftId) {
  return db
    .prepare(
      `SELECT sh.*, u.name AS user_name, ${SHIFT_TOTALS}
       FROM shifts sh JOIN users u ON u.id = sh.user_id WHERE sh.id = ?`
    )
    .get(shiftId);
}

/**
 * Открытая смена сотрудника (строка БД) или undefined.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} userId
 */
export function getOpenShift(db, userId) {
  return db
    .prepare("SELECT * FROM shifts WHERE user_id = ? AND closed_at IS NULL")
    .get(userId);
}

/** Открытая смена сотрудника с итогами (для интерфейса) или null. */
export function currentShift(db, userId) {
  const open = getOpenShift(db, userId);
  return open ? toShiftOut(getShiftRow(db, open.id)) : null;
}

// Кто может проводить денежные операции без открытой кассовой смены:
// владелец и разработчик. Всем остальным (управляющий, администратор,
// кассир) смена обязательна — иначе выручка повисает вне кассы и её
// не с кем сверить.
const SHIFT_FREE_ROLES = new Set(["developer", "owner"]);

/**
 * Смена, к которой привязывается денежная операция сотрудника (открытие
 * стола, пополнение счёта клиента и т. п.).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, role: string}} user
 * @returns {number | null} id смены
 */
export function requireShiftFor(db, user) {
  const shift = getOpenShift(db, user.id);
  if (!shift && !SHIFT_FREE_ROLES.has(user.role)) {
    throw new ConflictError(
      "Сначала откройте кассовую смену — без неё эту операцию не выполнить"
    );
  }
  return shift?.id ?? null;
}

/**
 * Открывает кассовую смену.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, name: string}} user
 * @param {{openingCash?: number | null}} [options] наличные в кассе на
 *   начало смены, рублей (null — не указано)
 */
export function openShift(db, user, { openingCash = null } = {}) {
  if (getOpenShift(db, user.id)) {
    throw new ConflictError("У вас уже есть открытая смена");
  }
  const openingKopecks = openingCash === null ? null : rublesToKopecks(openingCash);
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO shifts (user_id, opened_at, opening_cash_kopecks) VALUES (?, ?, ?)"
    )
    .run(user.id, utcNow(), openingKopecks);
  logEvent(
    db,
    JournalEvent.SHIFT_OPENED,
    `Открыта кассовая смена — ${user.name}` +
      (openingKopecks !== null
        ? `, в кассе ${kopecksToRubles(openingKopecks).toFixed(2)} ${getClubSettings(db).currency}`
        : "")
  );
  return toShiftOut(getShiftRow(db, Number(lastInsertRowid)));
}

/**
 * Закрывает кассовую смену, возвращает итоги и расхождение по наличным.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, name: string}} user
 * @param {{closingCash?: number | null}} [options] фактические наличные
 *   в кассе при закрытии, рублей
 */
export function closeShift(db, user, { closingCash = null } = {}) {
  const open = getOpenShift(db, user.id);
  if (!open) {
    throw new ConflictError("Открытой смены нет — закрывать нечего");
  }
  const closingKopecks = closingCash === null ? null : rublesToKopecks(closingCash);
  db.prepare(
    "UPDATE shifts SET closed_at = ?, closing_cash_kopecks = ? WHERE id = ?"
  ).run(utcNow(), closingKopecks, open.id);
  const shift = toShiftOut(getShiftRow(db, open.id));
  let message =
    `Закрыта кассовая смена — ${user.name}: сеансов ${shift.sessions_count}, ` +
    `выручка ${shift.revenue.toFixed(2)} ${getClubSettings(db).currency}`;
  if (shift.cash_discrepancy !== null) {
    message +=
      shift.cash_discrepancy === 0
        ? ", касса сошлась"
        : `, расхождение по кассе ${shift.cash_discrepancy.toFixed(2)} ${getClubSettings(db).currency}`;
  }
  logEvent(db, JournalEvent.SHIFT_CLOSED, message);
  return shift;
}

/** Причина движения: короткий человеческий текст, без него не понять отчёт. */
const REASON_MAX = 200;

/**
 * Выдача из кассы или внесение в кассу. Выдача — закупка, инкассация,
 * возврат гостю; внесение — размен, довложение. Пишется в открытую
 * смену того, кто выполняет операцию: касса всегда «чья-то».
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, name: string}} user
 * @param {{kind?: string, amount?: number, reason?: string}} data
 */
export function addCashMovement(db, user, { kind = "out", amount = null, reason = "" } = {}) {
  if (!["in", "out"].includes(kind)) {
    throw new ConflictError("Операция по кассе: выдача или внесение");
  }
  const open = getOpenShift(db, user.id);
  if (!open) {
    throw new ConflictError(
      "Сначала откройте кассовую смену — движение денег привязывается к ней"
    );
  }
  const sum = Number(amount);
  if (!Number.isFinite(sum) || sum <= 0) {
    throw new ConflictError("Сумма должна быть больше нуля");
  }
  const text = String(reason ?? "").trim();
  if (!text) {
    throw new ConflictError("Укажите, за что деньги — иначе в отчёте не разобраться");
  }
  if (text.length > REASON_MAX) {
    throw new ConflictError(`Причина — не длиннее ${REASON_MAX} символов`);
  }
  const kopecks = rublesToKopecks(sum);

  // Из кассы нельзя выдать больше, чем в ней есть по расчёту: иначе
  // получится отрицательный остаток, которого в жизни не бывает.
  if (kind === "out") {
    const shift = toShiftOut(getShiftRow(db, open.id));
    if (shift.expected_cash !== null && sum > shift.expected_cash) {
      throw new ConflictError(
        `В кассе по расчёту ${shift.expected_cash.toFixed(2)} ` +
          `${getClubSettings(db).currency} — выдать больше нельзя`
      );
    }
  }

  db.prepare(
    `INSERT INTO cash_movements
       (shift_id, user_id, kind, amount_kopecks, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(open.id, user.id, kind, kopecks, text, utcNow());
  logEvent(
    db,
    JournalEvent.CASH_MOVEMENT,
    `${kind === "out" ? "Выдано из кассы" : "Внесено в кассу"} ` +
      `${kopecksToRubles(kopecks).toFixed(2)} ${getClubSettings(db).currency} ` +
      `(${text}) — ${user.name}`
  );
  return toShiftOut(getShiftRow(db, open.id));
}

/** Движение денег по смене, новые сверху. */
export function listCashMovements(db, shiftId) {
  return db
    .prepare(
      `SELECT cm.id, cm.kind, cm.amount_kopecks, cm.reason, cm.created_at,
              u.name AS user_name
       FROM cash_movements cm JOIN users u ON u.id = cm.user_id
       WHERE cm.shift_id = ?
       ORDER BY cm.created_at DESC, cm.id DESC`
    )
    .all(shiftId)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: kopecksToRubles(row.amount_kopecks),
      reason: row.reason,
      created_at: row.created_at,
      user_name: row.user_name,
    }));
}

/**
 * Список смен, новые сверху. userId ограничивает выборку одним сотрудником
 * (для кассира); для администратора — все. dateFrom/dateTo («ГГГГ-ММ-ДД»)
 * фильтруют по дате открытия смены в местном часовом поясе клуба — так
 * можно найти, чья смена была в конкретный день.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{userId?: number, dateFrom?: string, dateTo?: string, limit?: number}} [options]
 */
export function listShifts(db, { userId, dateFrom, dateTo, limit = 100 } = {}) {
  const tz = getClubSettings(db).tz_offset_minutes;
  const modifier = `${tz >= 0 ? "+" : ""}${tz} minutes`;
  const where = [];
  const params = [];
  if (userId) {
    where.push("sh.user_id = ?");
    params.push(userId);
  }
  if (dateFrom) {
    where.push("date(sh.opened_at, ?) >= ?");
    params.push(modifier, dateFrom);
  }
  if (dateTo) {
    where.push("date(sh.opened_at, ?) <= ?");
    params.push(modifier, dateTo);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT sh.*, u.name AS user_name, ${SHIFT_TOTALS}
       FROM shifts sh JOIN users u ON u.id = sh.user_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY sh.opened_at DESC, sh.id DESC LIMIT ?`
    )
    .all(...params)
    .map(toShiftOut);
}
