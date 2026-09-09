// Меню бара/кухни. Цены — целые рубли (как у тарифов); в заказах
// цена фиксируется снимком в копейках.

import { utcNow } from "../db.js";
import { ConflictError, NotFoundError } from "./errors.js";

const toItem = (row) => ({ ...row, is_active: Boolean(row.is_active) });

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{onlyActive?: boolean}} [options]
 */
export function listMenu(db, { onlyActive = false } = {}) {
  const rows = db
    .prepare(
      `SELECT id, name, price, category, is_active, created_at FROM menu_items
       ${onlyActive ? "WHERE is_active = 1" : ""}
       ORDER BY category, name`
    )
    .all();
  return rows.map(toItem);
}

export function getMenuItem(db, itemId) {
  const row = db
    .prepare(
      "SELECT id, name, price, category, is_active, created_at FROM menu_items WHERE id = ?"
    )
    .get(itemId);
  if (!row) throw new NotFoundError(`Позиция меню id=${itemId} не найдена`);
  return toItem(row);
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{name: string, price: number, category?: string}} data
 */
export function createMenuItem(db, data) {
  const name = String(data.name ?? "").trim();
  if (!name) throw new ConflictError("Название позиции не может быть пустым");
  const price = Number(data.price);
  if (!Number.isInteger(price) || price <= 0) {
    throw new ConflictError("Цена должна быть целым числом рублей больше нуля");
  }
  if (db.prepare("SELECT id FROM menu_items WHERE name = ?").get(name)) {
    throw new ConflictError(`Позиция «${name}» уже есть в меню`);
  }
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO menu_items (name, price, category, is_active, created_at) VALUES (?, ?, ?, 1, ?)"
    )
    .run(name, price, String(data.category ?? "").trim(), utcNow());
  return getMenuItem(db, Number(lastInsertRowid));
}

/** Обновление позиции: цена, категория, название, активность. */
export function updateMenuItem(db, itemId, patch) {
  const item = getMenuItem(db, itemId);
  const next = {
    name: item.name,
    price: item.price,
    category: item.category,
    is_active: item.is_active,
  };
  if ("name" in patch) {
    next.name = String(patch.name ?? "").trim();
    if (!next.name) throw new ConflictError("Название позиции не может быть пустым");
  }
  if ("price" in patch) {
    const price = Number(patch.price);
    if (!Number.isInteger(price) || price <= 0) {
      throw new ConflictError("Цена должна быть целым числом рублей больше нуля");
    }
    next.price = price;
  }
  if ("category" in patch) next.category = String(patch.category ?? "").trim();
  if ("is_active" in patch) next.is_active = Boolean(patch.is_active);
  db.prepare(
    "UPDATE menu_items SET name = ?, price = ?, category = ?, is_active = ? WHERE id = ?"
  ).run(next.name, next.price, next.category, next.is_active ? 1 : 0, item.id);
  return getMenuItem(db, item.id);
}

/**
 * Удаляет позицию меню совсем. Заказы, в которых она уже фигурировала,
 * не ломаются — там название и цена сохранены отдельным снимком.
 */
export function deleteMenuItem(db, itemId) {
  const item = getMenuItem(db, itemId);
  db.prepare("DELETE FROM menu_items WHERE id = ?").run(itemId);
  return { ok: true, name: item.name };
}
