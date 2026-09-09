// Акции: «счастливый час» — скидка на время игры по дням недели и часам.
//
// Отличие от тарифных расписаний: расписание подставляет другой тариф
// (другую цену), акция же даёт процент скидки поверх любого тарифа.
// Клубу так проще: «по будням до 18:00 минус 30%» — одно правило на все
// столы и тарифы.
//
// Со скидкой клиента акции не складываются: берётся бо́льшая из двух.
// Иначе постоянный клиент в счастливый час играл бы почти даром, а это
// сюрприз для владельца, а не подарок гостю.

import { utcNow } from "../db.js";
import { ConflictError, NotFoundError } from "./errors.js";

const FIELDS = `
  id, name, discount_percent, days, start_minute, end_minute,
  is_active, created_at
`;

function toOut(row) {
  return {
    ...row,
    days: row.days.split(",").map(Number),
    is_active: Boolean(row.is_active),
  };
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function listPromotions(db, { onlyActive = false } = {}) {
  return db
    .prepare(
      `SELECT ${FIELDS} FROM promotions
       ${onlyActive ? "WHERE is_active = 1" : ""}
       ORDER BY id`
    )
    .all()
    .map(toOut);
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{name: string, discount_percent: number, days: number[],
 *          start_minute: number, end_minute: number}} data
 */
export function createPromotion(db, data) {
  const name = String(data.name ?? "").trim();
  if (!name) throw new ConflictError("У акции должно быть название");
  const percent = Number(data.discount_percent);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new ConflictError("Скидка акции: целое число 1–100 процентов");
  }
  const days = Array.isArray(data.days) ? [...new Set(data.days.map(Number))] : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new ConflictError("Дни недели: числа 1 (пн) … 7 (вс), минимум один");
  }
  const start = Number(data.start_minute);
  const end = Number(data.end_minute);
  if (!Number.isInteger(start) || start < 0 || start > 1439) {
    throw new ConflictError("Начало интервала: минуты 0–1439");
  }
  if (!Number.isInteger(end) || end < 0 || end > 1440 || end === start) {
    throw new ConflictError("Конец интервала: минуты 0–1440, не равен началу");
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO promotions
         (name, discount_percent, days, start_minute, end_minute, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
    .run(name, percent, days.sort((a, b) => a - b).join(","), start, end, utcNow());
  return listPromotions(db).find((p) => p.id === Number(lastInsertRowid));
}

/** Включает или выключает акцию, не удаляя её. */
export function setPromotionActive(db, promotionId, isActive) {
  const { changes } = db
    .prepare("UPDATE promotions SET is_active = ? WHERE id = ?")
    .run(isActive ? 1 : 0, promotionId);
  if (!changes) throw new NotFoundError(`Акция id=${promotionId} не найдена`);
  return listPromotions(db).find((p) => p.id === promotionId);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function deletePromotion(db, promotionId) {
  const { changes } = db.prepare("DELETE FROM promotions WHERE id = ?").run(promotionId);
  if (!changes) throw new NotFoundError(`Акция id=${promotionId} не найдена`);
}

/**
 * Действующая сейчас акция с самой большой скидкой (или null).
 * Интервал с концом раньше начала считается «через полночь» и относится
 * ко дню начала — как в тарифных расписаниях.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tzOffsetMinutes локальный пояс клуба
 * @param {string} [nowIso]
 */
export function activePromotion(db, tzOffsetMinutes, nowIso = utcNow()) {
  const local = new Date(Date.parse(nowIso) + tzOffsetMinutes * 60000);
  const day = ((local.getUTCDay() + 6) % 7) + 1;
  const prevDay = ((day + 5) % 7) + 1;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();

  let best = null;
  for (const promo of listPromotions(db, { onlyActive: true })) {
    const wraps = promo.end_minute <= promo.start_minute;
    const matches = wraps
      ? (promo.days.includes(day) && minute >= promo.start_minute) ||
        (promo.days.includes(prevDay) && minute < promo.end_minute)
      : promo.days.includes(day) &&
        minute >= promo.start_minute &&
        minute < promo.end_minute;
    if (!matches) continue;
    if (!best || promo.discount_percent > best.discount_percent) best = promo;
  }
  return best;
}
