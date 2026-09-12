// Живое состояние клуба — прямо из его базы, сейчас: занятые столы,
// выручка за сегодня, кто на смене, молчащие реле. Есть только в сети
// клубов: там все базы в одном процессе и спрашивать никого не надо.
// Одиночной установке этот раздел не показывается — её панель только
// про подписки.

import { kopecksToRubles } from "../services/billing.js";
import { relayOnline } from "../services/lighting.js";
import { getClubSettings } from "../services/settings.js";

const BOUND =
  "((light_kind IS NOT NULL AND light_kind != '') OR (tuya_device_id IS NOT NULL AND tuya_device_id != ''))";

/**
 * @param {import("node:sqlite").DatabaseSync} db база клуба
 */
export function clubLiveStats(db) {
  // «Сегодня» — с местной полуночи клуба, как в его собственной статистике.
  const tz = getClubSettings(db).tz_offset_minutes;
  const nowLocal = new Date(Date.now() + tz * 60000);
  const midnight = new Date(
    Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()) -
      tz * 60000
  ).toISOString();

  const tables = db.prepare("SELECT COUNT(*) AS n FROM tables WHERE is_active = 1").get().n;
  const busy = db.prepare("SELECT COUNT(*) AS n FROM table_sessions WHERE ended_at IS NULL").get().n;
  const today = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_kopecks), 0) AS total
       FROM table_sessions WHERE ended_at IS NOT NULL AND ended_at >= ?`
    )
    .get(midnight);
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
    sessions_today: today.n,
    revenue_today: kopecksToRubles(today.total),
    shift: shift ? { cashier: shift.name, opened_at: shift.opened_at } : null,
    relays_total: relays.length,
    relays_offline: relays.filter(([scope, id]) => relayOnline(db, scope, id) === false).length,
    last_activity_at: lastActivity,
  };
}
