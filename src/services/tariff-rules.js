// Тарифные расписания: правила «дни недели + интервал времени -> тариф».
// По ним система сама подставляет тариф при открытии стола (кассир может
// выбрать другой вручную). Время — локальное для клуба (настройка
// tz_offset_minutes).

import { utcNow } from "../db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { getTariff } from "./tariffs.js";

const RULE_FIELDS = `
  r.id, r.tariff_id, tr.name AS tariff_name, tr.price_per_hour,
  r.days, r.start_minute, r.end_minute, r.created_at
`;

/** @param {import("node:sqlite").DatabaseSync} db */
export function listRules(db) {
  return db
    .prepare(
      `SELECT ${RULE_FIELDS} FROM tariff_rules r
       JOIN tariffs tr ON tr.id = r.tariff_id
       ORDER BY r.id`
    )
    .all()
    .map((r) => ({ ...r, days: r.days.split(",").map(Number) }));
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{tariff_id: number, days: number[], start_minute: number, end_minute: number}} data
 */
export function createRule(db, data) {
  const tariff = getTariff(db, Number(data.tariff_id));
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
      "INSERT INTO tariff_rules (tariff_id, days, start_minute, end_minute, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(tariff.id, days.sort((a, b) => a - b).join(","), start, end, utcNow());
  return listRules(db).find((r) => r.id === Number(lastInsertRowid));
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function deleteRule(db, ruleId) {
  const { changes } = db.prepare("DELETE FROM tariff_rules WHERE id = ?").run(ruleId);
  if (!changes) throw new NotFoundError(`Правило id=${ruleId} не найдено`);
}

/**
 * Тариф по расписанию на момент времени (или null, если правил нет /
 * ни одно не подошло / тариф правила отключён).
 * Интервал с end < start считается «через полночь» и относится ко дню начала.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tzOffsetMinutes локальный пояс клуба
 * @param {string} [nowIso] момент времени (по умолчанию — сейчас)
 */
export function resolveTariffId(db, tzOffsetMinutes, nowIso = utcNow()) {
  const local = new Date(Date.parse(nowIso) + tzOffsetMinutes * 60000);
  // ISO-день недели: 1 = понедельник … 7 = воскресенье.
  const day = ((local.getUTCDay() + 6) % 7) + 1;
  const prevDay = ((day + 5) % 7) + 1;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();

  for (const rule of listRules(db)) {
    const wraps = rule.end_minute <= rule.start_minute;
    const matches = wraps
      ? // «Через полночь»: вечер дня начала или утро следующего дня.
        (rule.days.includes(day) && minute >= rule.start_minute) ||
        (rule.days.includes(prevDay) && minute < rule.end_minute)
      : rule.days.includes(day) &&
        minute >= rule.start_minute &&
        minute < rule.end_minute;
    if (matches) {
      const tariff = db
        .prepare("SELECT id, is_active FROM tariffs WHERE id = ?")
        .get(rule.tariff_id);
      if (tariff?.is_active) return tariff.id;
    }
  }
  return null;
}
