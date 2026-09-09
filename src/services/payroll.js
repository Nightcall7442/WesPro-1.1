// Учёт рабочих часов и начислений сотрудникам.
//
// Часы берём из кассовых смен: смена открыта — человек на работе,
// закрыта — рабочий день кончился. Отдельного табеля нет намеренно:
// смену и так открывают каждый день, а лишняя ручная отметка — лишний
// повод забыть.
//
// Начисление = часы × ставка + выручка смен × процент. Любая часть
// может быть нулём: кому-то платят только за часы, кому-то только
// процент. Выручка считается по сеансам, закрытым в его смену — так же,
// как в пересдаче кассы, поэтому цифры сходятся с отчётом по сменам.

import { kopecksToRubles } from "./billing.js";

/** Секунды в часах с двумя знаками — «7.5 ч» понятнее, чем 27000 секунд. */
function toHours(seconds) {
  return Math.round((seconds / 3600) * 100) / 100;
}

/**
 * Свод по сотрудникам за период.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{days?: number}} [options] сколько последних дней считать
 */
export function payrollReport(db, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Часы и выручка по сменам. Открытая смена считается до «сейчас»:
  // кассир на работе прямо в эту минуту, и часы уже идут.
  const rows = db
    .prepare(
      `SELECT
         u.id, u.name, u.login, u.role, u.is_active,
         u.hourly_rate_kopecks, u.revenue_percent,
         COUNT(sh.id) AS shifts_count,
         COALESCE(SUM(
           CAST(strftime('%s', COALESCE(sh.closed_at, 'now')) AS INTEGER)
           - CAST(strftime('%s', sh.opened_at) AS INTEGER)
         ), 0) AS seconds,
         COALESCE(SUM(
           (SELECT COALESCE(SUM(ts.total_cost_kopecks), 0)
              FROM table_sessions ts WHERE ts.close_shift_id = sh.id)
         ), 0) AS revenue_kopecks
       FROM users u
       LEFT JOIN shifts sh ON sh.user_id = u.id AND sh.opened_at >= ?
       GROUP BY u.id
       ORDER BY u.id`
    )
    .all(since);

  const people = rows
    // Сотрудники без смен и без ставки в отчёте только мешают.
    .filter((r) => r.shifts_count > 0 || r.hourly_rate_kopecks > 0 || r.revenue_percent > 0)
    .map((r) => {
      const hours = toHours(r.seconds);
      const forHours = Math.round((r.seconds / 3600) * r.hourly_rate_kopecks);
      const forRevenue = Math.round((r.revenue_kopecks * r.revenue_percent) / 100);
      return {
        user_id: r.id,
        name: r.name,
        login: r.login,
        role: r.role,
        is_active: Boolean(r.is_active),
        shifts_count: r.shifts_count,
        hours,
        revenue: kopecksToRubles(r.revenue_kopecks),
        hourly_rate: kopecksToRubles(r.hourly_rate_kopecks),
        revenue_percent: r.revenue_percent,
        pay_for_hours: kopecksToRubles(forHours),
        pay_for_revenue: kopecksToRubles(forRevenue),
        pay_total: kopecksToRubles(forHours + forRevenue),
      };
    });

  return {
    days,
    since,
    people,
    total_pay: Math.round(people.reduce((sum, p) => sum + p.pay_total, 0) * 100) / 100,
    total_hours: Math.round(people.reduce((sum, p) => sum + p.hours, 0) * 100) / 100,
  };
}
