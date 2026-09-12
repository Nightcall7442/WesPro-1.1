// Живое состояние клуба — прямо из его базы, сейчас: занятые столы,
// выручка за сегодня, кто на смене, молчащие реле. Есть только в сети
// клубов: там все базы в одном процессе и спрашивать никого не надо.
// Одиночной установке этот раздел не показывается — её панель только
// про подписки.

import { kopecksToRubles } from "../services/billing.js";
import { relayLastSeen, relayOnline } from "../services/lighting.js";
import { listDevices } from "../services/devices.js";
import { currentCostKopecks, getOpenSession } from "../services/sessions.js";
import { currentVersion } from "../services/diagnostics.js";
import { versionOf } from "../services/features.js";
import { enabledFeatures, getClubSettings } from "../services/settings.js";
import { listTables } from "../services/tables.js";

const BOUND =
  "((light_kind IS NOT NULL AND light_kind != '') OR (tuya_device_id IS NOT NULL AND tuya_device_id != ''))";
const DAY = 24 * 3600 * 1000;

/** Местная полночь клуба (ISO) для дня со сдвигом daysAgo назад. */
function midnightIso(tz, daysAgo = 0) {
  const nowLocal = new Date(Date.now() + tz * 60000 - daysAgo * DAY);
  return new Date(
    Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()) -
      tz * 60000
  ).toISOString();
}

/** Выручка по местным часам между двумя моментами: 24 числа. */
function revenueByHour(db, tz, from, to) {
  const modifier = `${tz >= 0 ? "+" : ""}${tz} minutes`;
  const hours = new Array(24).fill(0);
  for (const row of db
    .prepare(
      `SELECT CAST(strftime('%H', ended_at, ?) AS INTEGER) AS h,
              COALESCE(SUM(total_cost_kopecks), 0) AS total
         FROM table_sessions
        WHERE ended_at IS NOT NULL AND ended_at >= ? AND ended_at < ?
        GROUP BY h`
    )
    .all(modifier, from, to)) {
    hours[row.h] = kopecksToRubles(row.total);
  }
  return hours;
}

function revenueBetween(db, from, to) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_kopecks), 0) AS total
         FROM table_sessions WHERE ended_at IS NOT NULL AND ended_at >= ? AND ended_at < ?`
    )
    .get(from, to);
  return { sessions: row.n, revenue: kopecksToRubles(row.total) };
}

/**
 * Сводные живые цифры клуба — для плитки и общей сводки сети.
 * @param {import("node:sqlite").DatabaseSync} db база клуба
 */
export function clubLiveStats(db) {
  const tz = getClubSettings(db).tz_offset_minutes;
  const today = midnightIso(tz);
  const yesterday = midnightIso(tz, 1);
  const weekAgo = midnightIso(tz, 6);
  const tomorrow = new Date(Date.parse(today) + DAY).toISOString();

  const tables = db.prepare("SELECT COUNT(*) AS n FROM tables WHERE is_active = 1").get().n;
  const busy = db.prepare("SELECT COUNT(*) AS n FROM table_sessions WHERE ended_at IS NULL").get().n;
  const todayTotals = revenueBetween(db, today, tomorrow);
  const yesterdayTotals = revenueBetween(db, yesterday, today);
  const weekTotals = revenueBetween(db, weekAgo, tomorrow);
  const shift =
    db
      .prepare(
        `SELECT s.opened_at, u.name FROM shifts s JOIN users u ON u.id = s.user_id
         WHERE s.closed_at IS NULL ORDER BY s.opened_at DESC LIMIT 1`
      )
      .get() ?? null;
  const relays = [
    ...db.prepare(`SELECT id FROM tables WHERE is_active = 1 AND ${BOUND}`).all().map((r) => ["table", r.id]),
    ...db.prepare(`SELECT id FROM devices WHERE ${BOUND}`).all().map((r) => ["device", r.id]),
  ];
  const lastActivity =
    db.prepare("SELECT MAX(created_at) AS at FROM journal_entries").get().at ?? null;

  return {
    tables_total: tables,
    tables_busy: busy,
    sessions_today: todayTotals.sessions,
    revenue_today: todayTotals.revenue,
    revenue_yesterday: yesterdayTotals.revenue,
    revenue_week: weekTotals.revenue,
    // Выручка по местным часам — для графика «сеть сегодня» и линии «вчера».
    hours_today: revenueByHour(db, tz, today, tomorrow),
    hours_yesterday: revenueByHour(db, tz, yesterday, today),
    shift: shift ? { cashier: shift.name, opened_at: shift.opened_at } : null,
    relays_total: relays.length,
    relays_offline: relays.filter(([scope, id]) => relayOnline(db, scope, id) === false).length,
    last_activity_at: lastActivity,
    // Что из новшеств включено клубу — и какая это версия.
    features: enabledFeatures(db),
    version: versionOf(enabledFeatures(db), currentVersion()),
  };
}

/**
 * Подробности для страницы клуба в панели: столы с сеансами, реле со
 * связью, устройства. Всё то, что кассир видит у себя на экране, — но
 * без права нажимать.
 * @param {import("node:sqlite").DatabaseSync} db база клуба
 */
export function clubLiveDetail(db) {
  const now = Date.now();
  const tables = listTables(db).map((table) => {
    const session = getOpenSession(db, table.id);
    const relayBound = table.light_kind || table.tuya_device_id;
    return {
      id: table.id,
      name: table.name,
      kind: table.kind,
      busy: Boolean(session),
      since: session?.started_at ?? null,
      elapsed_seconds: session ? Math.floor((now - Date.parse(session.started_at)) / 1000) : 0,
      cost: session ? kopecksToRubles(currentCostKopecks(db, session)) : 0,
      prepaid: Boolean(session?.prepaid_seconds || session?.prepaid_kopecks),
      relay: relayBound
        ? {
            kind: table.light_kind ?? "tuya",
            online: relayOnline(db, "table", table.id),
            last_seen: relayLastSeen(db, "table", table.id),
          }
        : null,
    };
  });
  const devices = listDevices(db).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    is_on: d.is_on,
    position: d.position,
    cycle_on: d.cycle_on,
    work_minutes: d.work_minutes,
    rest_minutes: d.rest_minutes,
    relay: d.light_kind || d.tuya_device_id ? { kind: d.light_kind ?? "tuya", online: d.online, last_seen: d.last_seen } : null,
  }));
  return { ...clubLiveStats(db), tables, devices };
}
