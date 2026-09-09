// Заказы бара, привязанные к открытому сеансу стола.
// Цена позиции фиксируется снимком в копейках на момент добавления;
// сумма бара входит в итоговый чек при закрытии стола.

import { utcNow } from "../db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { getMenuItem } from "./menu.js";
import { getOpenSession } from "./sessions.js";
import { getTable } from "./tables.js";

/**
 * Позиции заказа сеанса.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} sessionId
 */
export function listOrders(db, sessionId) {
  return db
    .prepare(
      `SELECT id, session_id, menu_item_id, item_name, price_kopecks, quantity,
              created_at
       FROM session_orders WHERE session_id = ? ORDER BY id`
    )
    .all(sessionId);
}

/** Сумма бара по сеансу, в копейках. */
export function ordersTotalKopecks(db, sessionId) {
  return db
    .prepare(
      "SELECT COALESCE(SUM(price_kopecks * quantity), 0) AS total FROM session_orders WHERE session_id = ?"
    )
    .get(sessionId).total;
}

/**
 * Добавляет позицию к открытому сеансу стола.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {{menu_item_id: number, quantity?: number}} data
 * @param {{id: number}} user
 */
export function addOrder(db, tableId, data, user) {
  const table = getTable(db, tableId);
  const session = getOpenSession(db, table.id);
  if (!session) {
    throw new ConflictError(`Стол «${table.name}» свободен — сначала откройте сеанс`);
  }
  const item = getMenuItem(db, Number(data.menu_item_id));
  if (!item.is_active) {
    throw new ConflictError(`Позиция «${item.name}» отключена`);
  }
  const quantity = Number(data.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100) {
    throw new ConflictError("Количество должно быть целым числом от 1 до 100");
  }
  db.prepare(
    `INSERT INTO session_orders
       (session_id, menu_item_id, item_name, price_kopecks, quantity, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(session.id, item.id, item.name, item.price * 100, quantity, user.id, utcNow());
  return {
    orders: listOrders(db, session.id),
    bar_total_kopecks: ordersTotalKopecks(db, session.id),
  };
}

/**
 * Удаляет позицию (только пока сеанс не закрыт).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} orderId
 */
export function removeOrder(db, orderId) {
  const order = db
    .prepare(
      `SELECT o.id, o.session_id, s.ended_at FROM session_orders o
       JOIN table_sessions s ON s.id = o.session_id WHERE o.id = ?`
    )
    .get(orderId);
  if (!order) throw new NotFoundError(`Позиция заказа id=${orderId} не найдена`);
  if (order.ended_at) {
    throw new ConflictError("Сеанс уже закрыт — заказ изменить нельзя");
  }
  db.prepare("DELETE FROM session_orders WHERE id = ?").run(orderId);
  return {
    orders: listOrders(db, order.session_id),
    bar_total_kopecks: ordersTotalKopecks(db, order.session_id),
  };
}
