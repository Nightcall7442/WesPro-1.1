// Преобразование строк БД в тела ответов API.

import { kopecksToRubles } from "../services/billing.js";
import { utcNow } from "../db.js";

/** Полное представление сеанса (открытие/закрытие/история). */
export function sessionToOut(session) {
  const end = session.ended_at ?? utcNow();
  const durationSeconds = Math.max(
    0,
    Math.floor((Date.parse(end) - Date.parse(session.started_at)) / 1000)
  );
  return {
    id: session.id,
    table_id: session.table_id,
    table_name: session.table_name,
    tariff_id: session.tariff_id,
    tariff_name: session.tariff_name,
    price_per_hour: session.price_per_hour_snapshot,
    started_at: session.started_at,
    ended_at: session.ended_at ?? null,
    duration_seconds: durationSeconds,
    opened_by_name: session.opened_by_name ?? null,
    closed_by_name: session.closed_by_name ?? null,
    client_name: session.client_name ?? null,
    discount_percent: session.discount_percent ?? 0,
    // Название акции, если скидку дала именно она (для чека и отчётов).
    promo_name: session.promo_name ?? null,
    is_free: Boolean(session.is_free),
    payment_method: session.payment_method ?? null,
    prepaid_seconds: session.prepaid_seconds ?? null,
    prepaid_mode: session.prepaid_mode ?? null,
    // Чек на остаток, которым оплачен сеанс (если играли по чеку).
    voucher_code: session.voucher_code ?? null,
    paid_by_voucher:
      session.voucher_kopecks ? kopecksToRubles(session.voucher_kopecks) : 0,
    prepaid_amount:
      session.prepaid_kopecks === null || session.prepaid_kopecks === undefined
        ? null
        : kopecksToRubles(session.prepaid_kopecks),
    time_cost:
      session.time_cost_kopecks === null || session.time_cost_kopecks === undefined
        ? null
        : kopecksToRubles(session.time_cost_kopecks),
    bar_cost:
      session.bar_cost_kopecks === null || session.bar_cost_kopecks === undefined
        ? null
        : kopecksToRubles(session.bar_cost_kopecks),
    total_cost:
      session.total_cost_kopecks === null || session.total_cost_kopecks === undefined
        ? null
        : kopecksToRubles(session.total_cost_kopecks),
  };
}
