// Журнал событий сети: регистрации, оплаты, просрочки, блокировки,
// входы поддержки. Единственная точка записи — как в журнале клуба.

export const HubEvent = Object.freeze({
  CLUB_CREATED: "club_created",
  CLUB_UPDATED: "club_updated",
  CLUB_BLOCKED: "club_blocked",
  CLUB_UNBLOCKED: "club_unblocked",
  CLUB_ARCHIVED: "club_archived",
  CLUB_RESTORED: "club_restored",
  SUBSCRIPTION_CHANGED: "subscription_changed",
  PAYMENT_ADDED: "payment_added",
  GRACE_GRANTED: "grace_granted",
  PLAN_CREATED: "plan_created",
  PLAN_UPDATED: "plan_updated",
  MESSAGE_SENT: "message_sent",
  SUPPORT_LOGIN: "support_login",
  KEY_ROTATED: "key_rotated",
  CLUB_ONLINE: "club_online",
  HUB_LOGIN: "hub_login",
});

export const HUB_EVENT_LABELS = Object.freeze({
  club_created: "Новый клуб",
  club_updated: "Изменён клуб",
  club_blocked: "Блокировка",
  club_unblocked: "Разблокировка",
  club_archived: "Архив",
  club_restored: "Возврат из архива",
  subscription_changed: "Подписка",
  payment_added: "Оплата",
  grace_granted: "Отсрочка",
  plan_created: "Создан тариф",
  plan_updated: "Изменён тариф",
  message_sent: "Сообщение клубам",
  support_login: "Вход поддержки",
  key_rotated: "Новый ключ",
  club_online: "Клуб на связи",
  hub_login: "Вход в панель",
});

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} event значение из HubEvent
 * @param {string} message человекочитаемое описание
 * @param {number | null} [clubId]
 */
export function logHubEvent(db, event, message, clubId = null) {
  db.prepare(
    "INSERT INTO hub_journal (event, message, club_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(event, message, clubId, new Date().toISOString());
}

/** @param {{clubId?: number | null, event?: string, limit?: number}} [options] */
export function listHubJournal(db, { clubId = null, event = "", limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (clubId) {
    where.push("j.club_id = ?");
    params.push(clubId);
  }
  if (event && event !== "all") {
    where.push("j.event = ?");
    params.push(event);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT j.id, j.event, j.message, j.club_id, j.created_at, c.name AS club_name
         FROM hub_journal j
         LEFT JOIN clubs c ON c.id = j.club_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ?`
    )
    .all(...params)
    .map((row) => ({
      id: row.id,
      event: row.event,
      event_label: HUB_EVENT_LABELS[row.event] ?? row.event,
      message: row.message,
      club_id: row.club_id ?? null,
      club_name: row.club_name ?? null,
      created_at: row.created_at,
    }));
}
