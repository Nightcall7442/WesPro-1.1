// План зала: размер сетки (в настройках) и элементы — стены, двери и
// декоративная мебель (диван/кресло/стол).
// Элементы хранятся прямоугольниками в клетках сетки; редактор рисует
// их кликами/протяжкой и сохраняет план целиком.

import { utcNow, withTransaction } from "../db.js";
import { ConflictError } from "./errors.js";
import { getSettings, saveSettings } from "./settings.js";

const MAX_ELEMENTS = 500;

// Стена и дверь — планировка помещения; диван/кресло/стол/телевизор —
// декоративный интерьер, чтобы на карте зала было видно расстановку мебели.
const ELEMENT_TYPES = new Set(["wall", "door", "sofa", "armchair", "deco_table", "tv"]);

/** @param {import("node:sqlite").DatabaseSync} db */
export function getPlan(db) {
  const settings = getSettings(db);
  return {
    cols: Number(settings.plan_cols),
    rows: Number(settings.plan_rows),
    elements: db
      .prepare("SELECT id, type, x, y, w, h FROM plan_elements ORDER BY id")
      .all(),
  };
}

function validateElement(el, cols, rows) {
  if (!ELEMENT_TYPES.has(el.type)) {
    throw new ConflictError(`Неизвестный элемент плана «${el.type}»`);
  }
  for (const key of ["x", "y", "w", "h"]) {
    if (!Number.isInteger(el[key])) {
      throw new ConflictError("Координаты элементов плана должны быть целыми");
    }
  }
  if (
    el.w < 1 || el.h < 1 ||
    el.x < 0 || el.y < 0 ||
    el.x + el.w > cols || el.y + el.h > rows
  ) {
    throw new ConflictError("Элемент плана выходит за пределы сетки");
  }
}

/**
 * Полностью заменяет план: размер сетки и все стены/двери.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{cols: number, rows: number, elements: Array}} data
 */
export function savePlan(db, data) {
  const cols = Number(data.cols);
  const rows = Number(data.rows);
  saveSettings(db, { plan_cols: String(cols), plan_rows: String(rows) });

  const elements = Array.isArray(data.elements) ? data.elements : [];
  if (elements.length > MAX_ELEMENTS) {
    throw new ConflictError(`Слишком много элементов плана (максимум ${MAX_ELEMENTS})`);
  }
  for (const el of elements) validateElement(el, cols, rows);

  withTransaction(db, () => {
    db.prepare("DELETE FROM plan_elements").run();
    const insert = db.prepare(
      "INSERT INTO plan_elements (type, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const el of elements) {
      insert.run(el.type, el.x, el.y, el.w, el.h, utcNow());
    }
  });
  return getPlan(db);
}
