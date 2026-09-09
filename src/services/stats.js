// Отчёты для администратора: нагруженность столов, выручка по дням,
// пиковые часы. Дни и часы считаются в локальном поясе клуба
// (настройка tz_offset_minutes).

import { kopecksToRubles } from "./billing.js";
import { getClubSettings } from "./settings.js";

/**
 * Сводка по каждому столу за последние N дней (по закрытым сеансам):
 * число сеансов, занятость в секундах, выручка.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} days
 */
export function tableLoad(db, days) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT t.id, t.name,
         COUNT(s.id) AS sessions_count,
         CAST(COALESCE(SUM(
           (julianday(s.ended_at) - julianday(s.started_at)) * 86400
         ), 0) AS INTEGER) AS busy_seconds,
         COALESCE(SUM(s.total_cost_kopecks), 0) AS revenue_kopecks
       FROM tables t
       LEFT JOIN table_sessions s
         ON s.table_id = t.id AND s.ended_at IS NOT NULL AND s.started_at >= ?
       GROUP BY t.id
       ORDER BY t.id`
    )
    .all(since);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sessions_count: r.sessions_count,
    busy_seconds: r.busy_seconds,
    revenue: kopecksToRubles(r.revenue_kopecks),
  }));
}

/**
 * Выручка по дням за период с разбивкой по способам оплаты
 * плюс распределение сеансов по часам суток (пиковые часы).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} days
 */
export function revenueReport(db, days) {
  const tz = getClubSettings(db).tz_offset_minutes;
  const modifier = `${tz >= 0 ? "+" : ""}${tz} minutes`;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // Оплату со счёта клиента вычитаем: эти деньги в кассу пришли при
  // пополнении, в наличных и карте этого дня их быть не должно.
  const sumBy = (method) =>
    `COALESCE(SUM(CASE WHEN s.payment_method = '${method}'
       THEN s.total_cost_kopecks - s.account_kopecks ELSE 0 END), 0)`;

  const dayRows = db
    .prepare(
      `SELECT date(s.ended_at, ?) AS day,
         COUNT(*) AS sessions_count,
         COALESCE(SUM(s.total_cost_kopecks), 0) AS total_kopecks,
         ${sumBy("cash")} AS cash_kopecks,
         ${sumBy("card")} AS card_kopecks,
         ${sumBy("transfer")} AS transfer_kopecks
       FROM table_sessions s
       WHERE s.ended_at IS NOT NULL AND s.ended_at >= ?
       GROUP BY day ORDER BY day`
    )
    .all(modifier, since);

  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', s.started_at, ?) AS INTEGER) AS hour,
         COUNT(*) AS sessions_count
       FROM table_sessions s
       WHERE s.ended_at IS NOT NULL AND s.ended_at >= ?
       GROUP BY hour`
    )
    .all(modifier, since);
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sessions_count: hourRows.find((r) => r.hour === hour)?.sessions_count ?? 0,
  }));

  return {
    days: dayRows.map((r) => ({
      day: r.day,
      sessions_count: r.sessions_count,
      total: kopecksToRubles(r.total_kopecks),
      cash: kopecksToRubles(r.cash_kopecks),
      card: kopecksToRubles(r.card_kopecks),
      transfer: kopecksToRubles(r.transfer_kopecks),
    })),
    hours,
  };
}

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/**
 * Сводный дашборд клуба: выручка за периоды, средний чек и длительность,
 * загруженность по дням недели, топ позиций бара.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function overview(db) {
  const tz = getClubSettings(db).tz_offset_minutes;
  const modifier = `${tz >= 0 ? "+" : ""}${tz} minutes`;

  const periodTotals = (sinceMs) => {
    const since = new Date(sinceMs).toISOString();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_kopecks), 0) AS total
         FROM table_sessions WHERE ended_at IS NOT NULL AND ended_at >= ?`
      )
      .get(since);
    return { sessions: row.n, revenue: kopecksToRubles(row.total) };
  };

  // «Сегодня» — с местной полуночи клуба.
  const nowLocal = new Date(Date.now() + tz * 60000);
  const midnightLocal = Date.UTC(
    nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()
  ) - tz * 60000;

  const month = periodTotals(Date.now() - 30 * 24 * 3600 * 1000);
  const monthAgg = db
    .prepare(
      `SELECT COALESCE(AVG(total_cost_kopecks), 0) AS avg_check,
         COALESCE(AVG((julianday(ended_at) - julianday(started_at)) * 86400), 0)
           AS avg_seconds
       FROM table_sessions WHERE ended_at IS NOT NULL AND ended_at >= ?`
    )
    .get(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());

  // Загруженность по дням недели за 30 дней (0=вс в strftime -> ISO 1..7).
  const weekdayRows = db
    .prepare(
      `SELECT CAST(strftime('%w', ended_at, ?) AS INTEGER) AS wd,
         COUNT(*) AS sessions_count,
         COALESCE(SUM(total_cost_kopecks), 0) AS revenue_kopecks
       FROM table_sessions
       WHERE ended_at IS NOT NULL AND ended_at >= ?
       GROUP BY wd`
    )
    .all(modifier, new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
  const weekdays = WEEKDAYS.map((name, index) => {
    const wd = (index + 1) % 7; // ISO Пн=1..Вс=7 -> strftime 1..6,0
    const row = weekdayRows.find((r) => r.wd === wd);
    return {
      name,
      sessions_count: row?.sessions_count ?? 0,
      revenue: kopecksToRubles(row?.revenue_kopecks ?? 0),
    };
  });

  const topBar = db
    .prepare(
      `SELECT o.item_name,
         SUM(o.quantity) AS quantity,
         SUM(o.price_kopecks * o.quantity) AS total_kopecks
       FROM session_orders o
       JOIN table_sessions s ON s.id = o.session_id
       WHERE s.ended_at IS NOT NULL AND s.ended_at >= ?
       GROUP BY o.item_name ORDER BY total_kopecks DESC LIMIT 5`
    )
    .all(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());

  return {
    today: periodTotals(midnightLocal),
    week: periodTotals(Date.now() - 7 * 24 * 3600 * 1000),
    month,
    avg_check: kopecksToRubles(Math.round(monthAgg.avg_check)),
    avg_duration_seconds: Math.round(monthAgg.avg_seconds),
    weekdays,
    top_bar: topBar.map((r) => ({
      item_name: r.item_name,
      quantity: r.quantity,
      total: kopecksToRubles(r.total_kopecks),
    })),
  };
}
