// Клубы сети: карточка, подписка, оплаты, блокировка.
//
// Статус подписки НЕ хранится «на честном слове» — он пересчитывается из
// дат при каждом чтении (refreshStatuses). Иначе клуб, у которого вчера
// кончилась оплата, так и остался бы «активным», пока кто-нибудь не
// откроет его карточку.

import { randomBytes } from "node:crypto";

import { hubNumber, newClubCode, uniqueClubSlug } from "./db.js";
import { ConflictError, NotFoundError } from "../services/errors.js";
import { logHubEvent, HubEvent } from "./journal.js";

/** Момент «сейчас» в том же формате, что и остальные даты в базе. */
export const now = () => new Date().toISOString();

/** Дата через N дней от указанной (или от сейчас). */
export function plusDays(days, from = null) {
  const base = from ? Date.parse(from) : Date.now();
  return new Date(base + days * 24 * 3600 * 1000).toISOString();
}

const CLUB_FIELDS = `
  c.id, c.name, c.city, c.owner_name, c.phone, c.email, c.note,
  c.plan_id, c.status, c.paid_until, c.grace_until, c.blocked_manually,
  c.api_key, c.code, c.slug, c.last_seen_at, c.app_version, c.tables_count, c.created_at,
  p.name AS plan_name, p.price_kopecks AS plan_price_kopecks,
  p.period_days AS plan_period_days,
  (SELECT COUNT(*) FROM club_payments pay WHERE pay.club_id = c.id) AS payments_count,
  (SELECT COALESCE(SUM(pay.amount_kopecks), 0) FROM club_payments pay
    WHERE pay.club_id = c.id) AS paid_total_kopecks
`;

const CLUB_JOIN = `FROM clubs c LEFT JOIN plans p ON p.id = c.plan_id`;

/**
 * Какой статус у клуба должен быть по датам на данный момент.
 *
 * Порядок важен: ручная блокировка сильнее любых дат (владелец решил —
 * значит решил), архив не воскресает сам, а пробный период отличается от
 * оплаченного только тем, что за него ещё ни разу не платили.
 */
export function statusFor(club, { graceDays, at = now() }) {
  if (club.status === "archived") return "archived";
  if (club.blocked_manually) return "blocked";
  if (!club.paid_until) return "blocked";
  if (at < club.paid_until) return club.payments_count > 0 ? "active" : "trial";
  // Оплата кончилась. Пока действует отсрочка — клуб работает, но
  // помечен просроченным, чтобы попасть в список «позвонить».
  const graceEnd = club.grace_until ?? plusDays(graceDays, club.paid_until);
  return at < graceEnd ? "overdue" : "blocked";
}

/**
 * Пересчитывает статусы всех клубов и записывает изменения в журнал сети.
 * Дёшево (одна выборка + точечные UPDATE) и вызывается на каждом чтении
 * списка, поэтому панель всегда показывает правду.
 * @returns {number} сколько клубов сменили статус
 */
export function refreshStatuses(db, at = now()) {
  const graceDays = hubNumber(db, "grace_days");
  const rows = db.prepare(`SELECT ${CLUB_FIELDS} ${CLUB_JOIN}`).all();
  let changed = 0;
  const update = db.prepare("UPDATE clubs SET status = ? WHERE id = ?");
  for (const club of rows) {
    const next = statusFor(club, { graceDays, at });
    if (next === club.status) continue;
    update.run(next, club.id);
    changed += 1;
    logHubEvent(
      db,
      next === "blocked" ? HubEvent.CLUB_BLOCKED : HubEvent.SUBSCRIPTION_CHANGED,
      `Клуб «${club.name}»: подписка ${STATUS_LABELS[club.status] ?? club.status} → ` +
        `${STATUS_LABELS[next] ?? next}`,
      club.id
    );
  }
  return changed;
}

export const STATUS_LABELS = Object.freeze({
  trial: "пробный период",
  active: "активна",
  overdue: "просрочена",
  blocked: "заблокирован",
  archived: "в архиве",
});

function toOut(club, { offlineHours }) {
  const silentFor = club.last_seen_at
    ? (Date.now() - Date.parse(club.last_seen_at)) / 3600000
    : null;
  return {
    id: club.id,
    name: club.name,
    city: club.city,
    owner_name: club.owner_name,
    phone: club.phone,
    email: club.email,
    note: club.note,
    plan_id: club.plan_id ?? null,
    plan_name: club.plan_name ?? null,
    plan_price: (club.plan_price_kopecks ?? 0) / 100,
    plan_period_days: club.plan_period_days ?? null,
    status: club.status,
    status_label: STATUS_LABELS[club.status] ?? club.status,
    paid_until: club.paid_until ?? null,
    grace_until: club.grace_until ?? null,
    blocked_manually: Boolean(club.blocked_manually),
    days_left:
      club.paid_until === null
        ? null
        : Math.ceil((Date.parse(club.paid_until) - Date.now()) / 86400000),
    api_key: club.api_key,
    code: club.code ?? null,
    slug: club.slug ?? null,
    last_seen_at: club.last_seen_at ?? null,
    // «Потерялся»: программа клуба давно не отмечалась на связи.
    offline: silentFor === null || silentFor > offlineHours,
    app_version: club.app_version ?? null,
    tables_count: club.tables_count ?? null,
    payments_count: club.payments_count,
    paid_total: club.paid_total_kopecks / 100,
    created_at: club.created_at,
  };
}

/** @param {{status?: string, query?: string}} [options] */
export function listClubs(db, { status = "", query = "" } = {}) {
  refreshStatuses(db);
  const offlineHours = hubNumber(db, "offline_hours");
  const where = [];
  const params = [];
  if (status && status !== "all") {
    where.push("c.status = ?");
    params.push(status);
  }
  if (query.trim()) {
    where.push("(c.name LIKE ? OR c.city LIKE ? OR c.phone LIKE ? OR c.owner_name LIKE ?)");
    const like = `%${query.trim()}%`;
    params.push(like, like, like, like);
  }
  return db
    .prepare(
      `SELECT ${CLUB_FIELDS} ${CLUB_JOIN}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY c.name`
    )
    .all(...params)
    .map((club) => toOut(club, { offlineHours }));
}

/** Строка клуба как есть (внутреннее использование). */
export function clubRow(db, clubId) {
  const row = db.prepare(`SELECT ${CLUB_FIELDS} ${CLUB_JOIN} WHERE c.id = ?`).get(clubId);
  if (!row) throw new NotFoundError(`Клуб id=${clubId} не найден`);
  return row;
}

export function getClub(db, clubId) {
  refreshStatuses(db);
  return toOut(clubRow(db, clubId), { offlineHours: hubNumber(db, "offline_hours") });
}

/**
 * Клуб по адресу в сети. Строка как есть, без пересчёта статусов: этим
 * пользуется маршрутизация запросов (какому клубу отдать запрос), она
 * случается на каждый запрос и лишних записей в базу делать не должна.
 * Актуальный статус вызывающий считает сам — statusFor().
 */
export function clubByCode(db, code) {
  const value = String(code ?? "").trim();
  if (!value) return null;
  return db.prepare(`SELECT ${CLUB_FIELDS} ${CLUB_JOIN} WHERE c.code = ?`).get(value) ?? null;
}

/** Клуб по читаемому адресу (/login/adminpanel/<slug>). */
export function clubBySlug(db, slug) {
  const value = String(slug ?? "").trim().toLowerCase();
  if (!value) return null;
  return db.prepare(`SELECT ${CLUB_FIELDS} ${CLUB_JOIN} WHERE c.slug = ?`).get(value) ?? null;
}

/** Клуб по почте владельца — вход в программу по почте и паролю. */
export function clubByEmail(db, email) {
  const value = String(email ?? "").trim().toLowerCase();
  if (!value) return null;
  return (
    db
      .prepare(`SELECT ${CLUB_FIELDS} ${CLUB_JOIN} WHERE c.email = ? AND c.status <> 'archived'`)
      .get(value) ?? null
  );
}

export function clubByApiKey(db, apiKey) {
  const key = String(apiKey ?? "").trim();
  if (!key) return null;
  return db.prepare(`SELECT ${CLUB_FIELDS} ${CLUB_JOIN} WHERE c.api_key = ?`).get(key) ?? null;
}

function requireName(name) {
  const text = String(name ?? "").trim();
  if (text.length < 2) throw new ConflictError("Название клуба: минимум 2 символа");
  return text;
}

/**
 * Заводит клуб. Пробный период начинается сразу — иначе новый клуб был
 * бы заблокирован в первую же минуту и не смог бы даже посмотреть.
 */
export function createClub(db, data, author = null) {
  const name = requireName(data?.name);
  if (db.prepare("SELECT id FROM clubs WHERE name = ?").get(name)) {
    throw new ConflictError(`Клуб «${name}» уже есть в сети`);
  }
  const planId = data?.plan_id ? Number(data.plan_id) : null;
  if (planId && !db.prepare("SELECT id FROM plans WHERE id = ?").get(planId)) {
    throw new NotFoundError(`Тариф id=${planId} не найден`);
  }
  const trialDays = Number(data?.trial_days ?? hubNumber(db, "trial_days"));
  const paidUntil = plusDays(trialDays > 0 ? trialDays : hubNumber(db, "trial_days"));
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO clubs
         (name, city, owner_name, phone, email, note, plan_id, status,
          paid_until, api_key, code, slug, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'trial', ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      String(data?.city ?? "").trim(),
      String(data?.owner_name ?? "").trim(),
      String(data?.phone ?? "").trim(),
      String(data?.email ?? "").trim(),
      String(data?.note ?? "").trim(),
      planId,
      paidUntil,
      randomBytes(24).toString("hex"),
      newClubCode(),
      uniqueClubSlug(db, name),
      now()
    );
  const club = clubRow(db, Number(lastInsertRowid));
  logHubEvent(
    db,
    HubEvent.CLUB_CREATED,
    `Новый клуб «${club.name}»${club.city ? `, ${club.city}` : ""} — ` +
      `пробный период до ${paidUntil.slice(0, 10)}` +
      (author ? ` (${author.name})` : ""),
    club.id
  );
  return getClub(db, club.id);
}

const EDITABLE = ["name", "city", "owner_name", "phone", "email", "note"];

export function updateClub(db, clubId, patch, author = null) {
  const club = clubRow(db, clubId);
  const next = {};
  for (const field of EDITABLE) {
    if (patch?.[field] === undefined) continue;
    next[field] = field === "name" ? requireName(patch[field]) : String(patch[field]).trim();
  }
  if (next.name && next.name !== club.name) {
    if (db.prepare("SELECT id FROM clubs WHERE name = ? AND id <> ?").get(next.name, clubId)) {
      throw new ConflictError(`Клуб «${next.name}» уже есть в сети`);
    }
  }
  if (patch?.plan_id !== undefined) {
    const planId = patch.plan_id === null || patch.plan_id === "" ? null : Number(patch.plan_id);
    if (planId && !db.prepare("SELECT id FROM plans WHERE id = ?").get(planId)) {
      throw new NotFoundError(`Тариф id=${planId} не найден`);
    }
    next.plan_id = planId;
  }
  if (!Object.keys(next).length) return getClub(db, clubId);
  db.prepare(
    `UPDATE clubs SET ${Object.keys(next).map((f) => `${f} = ?`).join(", ")} WHERE id = ?`
  ).run(...Object.values(next), clubId);
  logHubEvent(
    db,
    HubEvent.CLUB_UPDATED,
    `Изменена карточка клуба «${next.name ?? club.name}»` + (author ? ` — ${author.name}` : ""),
    clubId
  );
  return getClub(db, clubId);
}

/**
 * Отмечает оплату: продлевает подписку и пишет строку в историю.
 * Продлеваем от текущей даты оплаты, а не от «сегодня» — иначе клуб,
 * заплативший заранее, терял бы уже оплаченные дни.
 */
export function addPayment(db, clubId, data, author = null) {
  const club = clubRow(db, clubId);
  const amount = Math.round(Number(data?.amount ?? 0) * 100);
  if (!Number.isInteger(amount) || amount < 0) {
    throw new ConflictError("Сумма оплаты не может быть отрицательной");
  }
  const days = Number(data?.days ?? club.plan_period_days ?? 30);
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    throw new ConflictError("Срок продления: от 1 до 3650 дней");
  }
  // Если оплата просрочена, считаем от сегодня: платить за дни, когда
  // клуб не работал, никто не станет.
  const from = club.paid_until && club.paid_until > now() ? club.paid_until : now();
  const paidUntil = plusDays(days, from);
  db.prepare(
    `INSERT INTO club_payments
       (club_id, amount_kopecks, days, paid_until, method, comment, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    clubId,
    amount,
    days,
    paidUntil,
    String(data?.method ?? "cash"),
    String(data?.comment ?? "").trim(),
    author?.id ?? null,
    now()
  );
  // Оплата снимает и отсрочку, и ручную блокировку: деньги пришли.
  db.prepare(
    "UPDATE clubs SET paid_until = ?, grace_until = NULL, blocked_manually = 0 WHERE id = ?"
  ).run(paidUntil, clubId);
  logHubEvent(
    db,
    HubEvent.PAYMENT_ADDED,
    `Оплата клуба «${club.name}»: ${(amount / 100).toFixed(2)} за ${days} дн., ` +
      `подписка до ${paidUntil.slice(0, 10)}` + (author ? ` — ${author.name}` : ""),
    clubId
  );
  refreshStatuses(db);
  return getClub(db, clubId);
}

export function listPayments(db, clubId) {
  return db
    .prepare(
      `SELECT pay.id, pay.amount_kopecks, pay.days, pay.paid_until, pay.method,
              pay.comment, pay.created_at, u.name AS created_by_name
         FROM club_payments pay
         LEFT JOIN hub_users u ON u.id = pay.created_by
        WHERE pay.club_id = ?
        ORDER BY pay.created_at DESC, pay.id DESC`
    )
    .all(clubId)
    .map((row) => ({
      id: row.id,
      amount: row.amount_kopecks / 100,
      days: row.days,
      paid_until: row.paid_until,
      method: row.method,
      comment: row.comment,
      created_at: row.created_at,
      created_by_name: row.created_by_name ?? null,
    }));
}

/** Отсрочка блокировки: «оплатят на следующей неделе, не выключай». */
export function grantGrace(db, clubId, days, author = null) {
  const club = clubRow(db, clubId);
  const count = Number(days);
  if (!Number.isInteger(count) || count <= 0 || count > 180) {
    throw new ConflictError("Отсрочка: от 1 до 180 дней");
  }
  const until = plusDays(count);
  db.prepare("UPDATE clubs SET grace_until = ?, blocked_manually = 0 WHERE id = ?").run(
    until,
    clubId
  );
  logHubEvent(
    db,
    HubEvent.GRACE_GRANTED,
    `Клубу «${club.name}» дана отсрочка на ${count} дн. — до ${until.slice(0, 10)}` +
      (author ? ` (${author.name})` : ""),
    clubId
  );
  refreshStatuses(db);
  return getClub(db, clubId);
}

/** Блокировка и разблокировка руками. */
export function setBlocked(db, clubId, blocked, author = null) {
  const club = clubRow(db, clubId);
  db.prepare("UPDATE clubs SET blocked_manually = ? WHERE id = ?").run(blocked ? 1 : 0, clubId);
  if (!blocked) {
    // Сняли блокировку у клуба с истёкшей оплатой — даём отсрочку, иначе
    // пересчёт статусов заблокирует его обратно в ту же секунду.
    const fresh = clubRow(db, clubId);
    if (!fresh.paid_until || fresh.paid_until <= now()) {
      db.prepare("UPDATE clubs SET grace_until = ? WHERE id = ?").run(
        plusDays(hubNumber(db, "grace_days")),
        clubId
      );
    }
  }
  logHubEvent(
    db,
    blocked ? HubEvent.CLUB_BLOCKED : HubEvent.CLUB_UNBLOCKED,
    `Клуб «${club.name}» ${blocked ? "заблокирован" : "разблокирован"} вручную` +
      (author ? ` — ${author.name}` : ""),
    clubId
  );
  refreshStatuses(db);
  return getClub(db, clubId);
}

/** Архив: клуб ушёл из сети, но история оплат остаётся. */
export function archiveClub(db, clubId, author = null) {
  const club = clubRow(db, clubId);
  db.prepare("UPDATE clubs SET status = 'archived' WHERE id = ?").run(clubId);
  logHubEvent(
    db,
    HubEvent.CLUB_ARCHIVED,
    `Клуб «${club.name}» отправлен в архив` + (author ? ` — ${author.name}` : ""),
    clubId
  );
  return getClub(db, clubId);
}

/** Возврат из архива: снова пробный период на стандартный срок. */
export function restoreClub(db, clubId, author = null) {
  const club = clubRow(db, clubId);
  db.prepare(
    "UPDATE clubs SET status = 'overdue', grace_until = ?, blocked_manually = 0 WHERE id = ?"
  ).run(plusDays(hubNumber(db, "grace_days")), clubId);
  logHubEvent(
    db,
    HubEvent.CLUB_RESTORED,
    `Клуб «${club.name}» возвращён из архива` + (author ? ` — ${author.name}` : ""),
    clubId
  );
  refreshStatuses(db);
  return getClub(db, clubId);
}

/** Новый ключ доступа: старый перестаёт работать сразу. */
export function rotateApiKey(db, clubId, author = null) {
  const club = clubRow(db, clubId);
  const key = randomBytes(24).toString("hex");
  db.prepare("UPDATE clubs SET api_key = ? WHERE id = ?").run(key, clubId);
  logHubEvent(
    db,
    HubEvent.KEY_ROTATED,
    `Клубу «${club.name}» выдан новый ключ доступа` + (author ? ` — ${author.name}` : ""),
    clubId
  );
  return getClub(db, clubId);
}
