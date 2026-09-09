// Тарифные планы сервиса: сколько клуб платит за подписку и что входит.
// Это НЕ тарифы столов внутри клуба — те живут в базе самого клуба.

import { ConflictError, NotFoundError } from "../services/errors.js";
import { HubEvent, logHubEvent } from "./journal.js";

const PLAN_FIELDS = `
  p.id, p.name, p.price_kopecks, p.period_days, p.max_tables,
  p.description, p.is_active, p.created_at,
  (SELECT COUNT(*) FROM clubs c WHERE c.plan_id = p.id AND c.status <> 'archived')
    AS clubs_count
`;

function toOut(row) {
  return {
    id: row.id,
    name: row.name,
    price: row.price_kopecks / 100,
    period_days: row.period_days,
    max_tables: row.max_tables ?? null,
    description: row.description,
    is_active: Boolean(row.is_active),
    clubs_count: row.clubs_count,
    created_at: row.created_at,
  };
}

export function listPlans(db, { activeOnly = false } = {}) {
  return db
    .prepare(
      `SELECT ${PLAN_FIELDS} FROM plans p
       ${activeOnly ? "WHERE p.is_active = 1" : ""}
       ORDER BY p.price_kopecks, p.name`
    )
    .all()
    .map(toOut);
}

export function getPlan(db, planId) {
  const row = db.prepare(`SELECT ${PLAN_FIELDS} FROM plans p WHERE p.id = ?`).get(planId);
  if (!row) throw new NotFoundError(`Тариф id=${planId} не найден`);
  return toOut(row);
}

function validate(data, { partial = false } = {}) {
  const out = {};
  if (data?.name !== undefined || !partial) {
    const name = String(data?.name ?? "").trim();
    if (name.length < 2) throw new ConflictError("Название тарифа: минимум 2 символа");
    out.name = name;
  }
  if (data?.price !== undefined || !partial) {
    const price = Math.round(Number(data?.price ?? 0) * 100);
    if (!Number.isInteger(price) || price < 0) {
      throw new ConflictError("Цена тарифа не может быть отрицательной");
    }
    out.price_kopecks = price;
  }
  if (data?.period_days !== undefined || !partial) {
    const days = Number(data?.period_days ?? 30);
    if (!Number.isInteger(days) || days <= 0 || days > 3650) {
      throw new ConflictError("Период тарифа: от 1 до 3650 дней");
    }
    out.period_days = days;
  }
  if (data?.max_tables !== undefined) {
    const max =
      data.max_tables === null || data.max_tables === "" ? null : Number(data.max_tables);
    if (max !== null && (!Number.isInteger(max) || max <= 0)) {
      throw new ConflictError("Лимит столов: целое число больше нуля или пусто");
    }
    out.max_tables = max;
  }
  if (data?.description !== undefined) out.description = String(data.description).trim();
  if (data?.is_active !== undefined) out.is_active = data.is_active ? 1 : 0;
  return out;
}

export function createPlan(db, data, author = null) {
  const next = validate(data);
  if (db.prepare("SELECT id FROM plans WHERE name = ?").get(next.name)) {
    throw new ConflictError(`Тариф «${next.name}» уже есть`);
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO plans (name, price_kopecks, period_days, max_tables, description, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      next.name,
      next.price_kopecks,
      next.period_days,
      next.max_tables ?? null,
      next.description ?? "",
      next.is_active ?? 1,
      new Date().toISOString()
    );
  const plan = getPlan(db, Number(lastInsertRowid));
  logHubEvent(
    db,
    HubEvent.PLAN_CREATED,
    `Создан тариф «${plan.name}» — ${plan.price} за ${plan.period_days} дн.` +
      (author ? ` (${author.name})` : "")
  );
  return plan;
}

export function updatePlan(db, planId, patch, author = null) {
  const plan = getPlan(db, planId);
  const next = validate(patch, { partial: true });
  if (next.name && next.name !== plan.name) {
    if (db.prepare("SELECT id FROM plans WHERE name = ? AND id <> ?").get(next.name, planId)) {
      throw new ConflictError(`Тариф «${next.name}» уже есть`);
    }
  }
  if (!Object.keys(next).length) return plan;
  db.prepare(
    `UPDATE plans SET ${Object.keys(next).map((f) => `${f} = ?`).join(", ")} WHERE id = ?`
  ).run(...Object.values(next), planId);
  logHubEvent(
    db,
    HubEvent.PLAN_UPDATED,
    `Изменён тариф «${next.name ?? plan.name}»` + (author ? ` — ${author.name}` : "")
  );
  return getPlan(db, planId);
}

/**
 * Удаление тарифа. Клубы на нём остались бы без плана, поэтому удаляем
 * только неиспользуемый — иначе предлагаем просто отключить.
 */
export function deletePlan(db, planId) {
  const plan = getPlan(db, planId);
  if (plan.clubs_count > 0) {
    throw new ConflictError(
      `На тарифе «${plan.name}» ещё ${plan.clubs_count} клуб(ов) — ` +
        "переведите их на другой тариф или просто отключите этот"
    );
  }
  db.prepare("DELETE FROM plans WHERE id = ?").run(planId);
  logHubEvent(db, HubEvent.PLAN_UPDATED, `Удалён тариф «${plan.name}»`);
  return { deleted: true };
}
