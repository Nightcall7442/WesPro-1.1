// Сводка по сети и «что требует внимания».
//
// Уведомления владельцу сервиса намеренно считаются на лету, а не
// копятся отдельной таблицей: список всегда отражает сегодняшнее
// положение дел, и не бывает «уведомления о просрочке, которую уже
// оплатили неделю назад».

import { hubNumber } from "./db.js";
import { refreshStatuses, STATUS_LABELS } from "./clubs.js";

const DAY = 86400000;

/** Общая статистика сети: сколько клубов, деньги, рост. */
export function networkStats(db) {
  refreshStatuses(db);
  const byStatus = Object.fromEntries(
    db
      .prepare("SELECT status, COUNT(*) AS n FROM clubs GROUP BY status")
      .all()
      .map((row) => [row.status, row.n])
  );
  const living = ["trial", "active", "overdue"].reduce(
    (sum, key) => sum + (byStatus[key] ?? 0),
    0
  );

  // Регулярная выручка: сумма тарифов клубов, которые сейчас платят,
  // приведённая к 30 дням — тарифы могут быть на разный срок.
  const mrr =
    db
      .prepare(
        `SELECT COALESCE(SUM(p.price_kopecks * 30.0 / p.period_days), 0) AS total
           FROM clubs c JOIN plans p ON p.id = c.plan_id
          WHERE c.status IN ('active', 'overdue')`
      )
      .get().total / 100;

  const since = new Date(Date.now() - 180 * DAY).toISOString();
  const months = db
    .prepare(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS clubs
         FROM clubs WHERE created_at >= ? GROUP BY month ORDER BY month`
    )
    .all(since);
  const income = db
    .prepare(
      `SELECT substr(created_at, 1, 7) AS month,
              COALESCE(SUM(amount_kopecks), 0) AS total
         FROM club_payments WHERE created_at >= ? GROUP BY month ORDER BY month`
    )
    .all(since);
  const incomeByMonth = new Map(income.map((row) => [row.month, row.total / 100]));

  const offlineHours = hubNumber(db, "offline_hours");
  const online = db
    .prepare(
      `SELECT COUNT(*) AS n FROM clubs
        WHERE status <> 'archived' AND last_seen_at IS NOT NULL AND last_seen_at >= ?`
    )
    .get(new Date(Date.now() - offlineHours * 3600000).toISOString()).n;

  return {
    clubs_total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    clubs_living: living,
    by_status: Object.fromEntries(
      Object.keys(STATUS_LABELS).map((key) => [key, byStatus[key] ?? 0])
    ),
    online,
    offline: living - online,
    mrr,
    paid_total:
      db.prepare("SELECT COALESCE(SUM(amount_kopecks), 0) AS total FROM club_payments").get()
        .total / 100,
    by_month: months.map((row) => ({
      month: row.month,
      clubs: row.clubs,
      income: incomeByMonth.get(row.month) ?? 0,
    })),
  };
}

/**
 * Что требует внимания прямо сейчас. Каждый пункт — повод позвонить:
 * подписка на исходе, клуб пропал со связи, кто-то только что появился.
 */
export function attentionList(db) {
  refreshStatuses(db);
  const warnDays = hubNumber(db, "expiry_warning_days");
  const offlineHours = hubNumber(db, "offline_hours");
  const items = [];

  const soon = db
    .prepare(
      `SELECT id, name, paid_until, status FROM clubs
        WHERE status IN ('trial', 'active') AND paid_until IS NOT NULL AND paid_until <= ?
        ORDER BY paid_until`
    )
    .all(new Date(Date.now() + warnDays * DAY).toISOString());
  for (const club of soon) {
    const days = Math.max(0, Math.ceil((Date.parse(club.paid_until) - Date.now()) / DAY));
    items.push({
      kind: "expiring",
      club_id: club.id,
      club_name: club.name,
      text:
        club.status === "trial"
          ? `Пробный период заканчивается ${days === 0 ? "сегодня" : `через ${days} дн.`}`
          : `Подписка заканчивается ${days === 0 ? "сегодня" : `через ${days} дн.`}`,
    });
  }

  for (const club of db
    .prepare(
      `SELECT id, name, paid_until FROM clubs WHERE status = 'overdue' ORDER BY paid_until`
    )
    .all()) {
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(club.paid_until)) / DAY));
    items.push({
      kind: "overdue",
      club_id: club.id,
      club_name: club.name,
      text: `Просрочка ${days} дн. — скоро отключится`,
    });
  }

  for (const club of db
    .prepare(
      `SELECT id, name, last_seen_at FROM clubs
        WHERE status <> 'archived' AND (last_seen_at IS NULL OR last_seen_at < ?)
        ORDER BY name`
    )
    .all(new Date(Date.now() - offlineHours * 3600000).toISOString())) {
    items.push({
      kind: "offline",
      club_id: club.id,
      club_name: club.name,
      text: club.last_seen_at
        ? `Не на связи с ${club.last_seen_at.slice(0, 16).replace("T", " ")}`
        : "Ни разу не выходил на связь",
    });
  }

  for (const club of db
    .prepare(
      `SELECT id, name, created_at FROM clubs WHERE created_at >= ? ORDER BY created_at DESC`
    )
    .all(new Date(Date.now() - 7 * DAY).toISOString())) {
    items.push({
      kind: "new",
      club_id: club.id,
      club_name: club.name,
      text: `Новый клуб в сети с ${club.created_at.slice(0, 10)}`,
    });
  }

  return items;
}
