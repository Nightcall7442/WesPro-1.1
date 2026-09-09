// Операции с тарифами.

import { utcNow, withTransaction } from "../db.js";
import { getClubSettings } from "./settings.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";

const toTariff = (row) => ({ ...row, is_active: Boolean(row.is_active) });

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{onlyActive?: boolean}} [options]
 */
export function listTariffs(db, { onlyActive = false } = {}) {
  const rows = db
    .prepare(
      `SELECT id, name, price_per_hour, is_active FROM tariffs
       ${onlyActive ? "WHERE is_active = 1" : ""} ORDER BY id`
    )
    .all();
  return rows.map(toTariff);
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tariffId
 */
export function getTariff(db, tariffId) {
  const row = db
    .prepare("SELECT id, name, price_per_hour, is_active FROM tariffs WHERE id = ?")
    .get(tariffId);
  if (!row) {
    throw new NotFoundError(`Тариф id=${tariffId} не найден`);
  }
  return toTariff(row);
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 * @param {number} pricePerHour рублей в час, целое > 0
 */
export function createTariff(db, name, pricePerHour) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    throw new ConflictError("Название тарифа не может быть пустым");
  }
  if (!Number.isInteger(pricePerHour) || pricePerHour <= 0) {
    throw new ConflictError("Цена тарифа должна быть целым числом больше нуля");
  }
  const exists = db.prepare("SELECT id FROM tariffs WHERE name = ?").get(trimmed);
  if (exists) {
    throw new ConflictError(`Тариф с названием «${trimmed}» уже существует`);
  }
  const id = withTransaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO tariffs (name, price_per_hour, is_active, created_at) VALUES (?, ?, 1, ?)"
      )
      .run(trimmed, pricePerHour, utcNow());
    logEvent(
      db,
      JournalEvent.TARIFF_CREATED,
      `Создан тариф «${trimmed}» — ${pricePerHour} ${getClubSettings(db).currency}/час`
    );
    return Number(lastInsertRowid);
  });
  return getTariff(db, id);
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tariffId
 * @param {{name?: string, price_per_hour?: number, is_active?: boolean}} patch
 */
export function updateTariff(db, tariffId, patch) {
  const tariff = getTariff(db, tariffId);
  const next = {
    name: tariff.name,
    price_per_hour: tariff.price_per_hour,
    is_active: tariff.is_active,
  };
  if ("name" in patch) {
    next.name = String(patch.name ?? "").trim();
    if (!next.name) throw new ConflictError("Название тарифа не может быть пустым");
    const dup = db
      .prepare("SELECT id FROM tariffs WHERE name = ? AND id != ?")
      .get(next.name, tariffId);
    if (dup) throw new ConflictError(`Тариф с названием «${next.name}» уже существует`);
  }
  if ("price_per_hour" in patch) {
    const price = Number(patch.price_per_hour);
    if (!Number.isInteger(price) || price <= 0) {
      throw new ConflictError("Цена тарифа должна быть целым числом больше нуля");
    }
    next.price_per_hour = price;
  }
  if ("is_active" in patch) next.is_active = Boolean(patch.is_active);

  db.prepare(
    "UPDATE tariffs SET name = ?, price_per_hour = ?, is_active = ? WHERE id = ?"
  ).run(next.name, next.price_per_hour, next.is_active ? 1 : 0, tariffId);
  logEvent(db, JournalEvent.TARIFF_UPDATED, `Изменён тариф «${next.name}»`);
  return getTariff(db, tariffId);
}

/**
 * Удаляет тариф. Если по нему уже есть история сеансов — удалить нельзя
 * (сломало бы историю и отчёты), тогда предлагается деактивировать вместо
 * удаления через updateTariff({is_active: false}).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tariffId
 */
export function deleteTariff(db, tariffId) {
  const tariff = getTariff(db, tariffId);
  const used = db
    .prepare("SELECT 1 FROM table_sessions WHERE tariff_id = ? LIMIT 1")
    .get(tariffId);
  if (used) {
    throw new ConflictError(
      `Тариф «${tariff.name}» уже использовался в сеансах — удалить нельзя, ` +
        "можно только деактивировать (тогда он пропадёт из выбора, но история сохранится)"
    );
  }
  withTransaction(db, () => {
    db.prepare("DELETE FROM tariffs WHERE id = ?").run(tariffId);
    logEvent(db, JournalEvent.TARIFF_DELETED, `Удалён тариф «${tariff.name}»`);
  });
  return { ok: true };
}
