// Клиентская база: постоянные клиенты и их персональные скидки.
// Скидка клиента фиксируется в сеансе при открытии стола.

import { utcNow } from "../db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";

const CLIENT_FIELDS = `
  c.id, c.name, c.phone, c.discount_percent, c.note, c.created_at,
  (SELECT COUNT(*) FROM table_sessions s
    WHERE s.client_id = c.id AND s.ended_at IS NOT NULL) AS visits
`;

// Статистика клиента по закрытым сеансам: сколько раз был, сколько
// оставил и сколько играл. Считается за всё время и за последние
// день / неделю / месяц — по этим числам видно постоянных гостей.
const STATS_SQL = `
  SELECT
    COUNT(*) AS visits,
    COALESCE(SUM(total_cost_kopecks), 0) AS spent_kopecks,
    -- Целые секунды: julianday даёт дробь и на нескольких сеансах
    -- накапливает погрешность в секунду-две.
    COALESCE(SUM(
      CAST(strftime('%s', ended_at) AS INTEGER)
        - CAST(strftime('%s', started_at) AS INTEGER)
    ), 0) AS seconds
  FROM table_sessions
  WHERE client_id = ? AND ended_at IS NOT NULL
`;

/** Свод по одному периоду: посещения, сумма, время, средний чек. */
function periodStats(db, clientId, sinceIso) {
  const row = sinceIso
    ? db.prepare(`${STATS_SQL} AND ended_at >= ?`).get(clientId, sinceIso)
    : db.prepare(STATS_SQL).get(clientId);
  const visits = row.visits ?? 0;
  const spent = row.spent_kopecks ?? 0;
  const seconds = Math.max(0, row.seconds ?? 0);
  return {
    visits,
    spent_kopecks: spent,
    seconds,
    // Средний расход за визит — то, что чаще всего и хотят видеть.
    average_kopecks: visits ? Math.round(spent / visits) : 0,
    average_seconds: visits ? Math.round(seconds / visits) : 0,
  };
}

const FAVORITE_LIMIT = 5;

/** Общий SQL-каркас для «любимых столов»/«любимых тарифов»: группировка
 * по названию, сортировка по числу визитов (чаще всего — тем и любимее),
 * при равенстве — по наигранному времени. */
function favoriteRows(db, clientId, groupTable, nameColumn, joinColumn) {
  return db
    .prepare(
      `SELECT ${nameColumn} AS name,
         COUNT(*) AS visits,
         COALESCE(SUM(
           CAST(strftime('%s', s.ended_at) AS INTEGER)
             - CAST(strftime('%s', s.started_at) AS INTEGER)
         ), 0) AS seconds,
         COALESCE(SUM(s.total_cost_kopecks), 0) AS spent_kopecks
       FROM table_sessions s
       JOIN ${groupTable} g ON g.id = s.${joinColumn}
       WHERE s.client_id = ? AND s.ended_at IS NOT NULL
       GROUP BY g.id
       ORDER BY visits DESC, seconds DESC
       LIMIT ${FAVORITE_LIMIT}`
    )
    .all(clientId)
    .map((r) => ({
      name: r.name,
      visits: r.visits,
      seconds: Math.max(0, r.seconds),
      spent_kopecks: r.spent_kopecks,
    }));
}

/**
 * Статистика клиента: за всё время и за день/неделю/месяц, плюс любимые
 * столы и тарифы (где и во что чаще всего играет) — помогает узнать
 * постоянного гостя и предложить именно то, что он обычно берёт.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} clientId
 */
export function clientStats(db, clientId) {
  const client = getClient(db, clientId);
  const now = Date.now();
  const ago = (days) => new Date(now - days * 24 * 3600 * 1000).toISOString();
  const last = db
    .prepare(
      `SELECT ended_at FROM table_sessions
       WHERE client_id = ? AND ended_at IS NOT NULL
       ORDER BY ended_at DESC LIMIT 1`
    )
    .get(clientId);
  return {
    client_id: client.id,
    name: client.name,
    discount_percent: client.discount_percent,
    last_visit: last?.ended_at ?? null,
    total: periodStats(db, clientId, null),
    day: periodStats(db, clientId, ago(1)),
    week: periodStats(db, clientId, ago(7)),
    month: periodStats(db, clientId, ago(30)),
    favorite_tables: favoriteRows(db, clientId, "tables", "g.name", "table_id"),
    favorite_tariffs: favoriteRows(db, clientId, "tariffs", "g.name", "tariff_id"),
  };
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{query?: string, limit?: number}} [options]
 */
export function listClients(db, { query = "", limit = 200 } = {}) {
  const q = `%${query.trim()}%`;
  return db
    .prepare(
      `SELECT ${CLIENT_FIELDS} FROM clients c
       WHERE c.name LIKE ? OR COALESCE(c.phone, '') LIKE ?
       ORDER BY c.name LIMIT ?`
    )
    .all(q, q, limit);
}

export function getClient(db, clientId) {
  const client = db
    .prepare(`SELECT ${CLIENT_FIELDS} FROM clients c WHERE c.id = ?`)
    .get(clientId);
  if (!client) throw new NotFoundError(`Клиент id=${clientId} не найден`);
  return client;
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{name: string, phone?: string, note?: string}} data
 * @param {{name: string}} author
 */
export function createClient(db, data, author) {
  const name = String(data.name ?? "").trim();
  if (!name) throw new ConflictError("Имя клиента не может быть пустым");
  const phone = String(data.phone ?? "").trim() || null;
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO clients (name, phone, discount_percent, note, created_at) VALUES (?, ?, 0, ?, ?)"
    )
    .run(name, phone, String(data.note ?? "").trim() || null, utcNow());
  logEvent(
    db,
    JournalEvent.CLIENT_CREATED,
    `Добавлен клиент «${name}» — ${author.name}`
  );
  return getClient(db, Number(lastInsertRowid));
}

/**
 * Обновление клиента (в т.ч. скидки — только администратором на уровне API).
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function updateClient(db, clientId, patch) {
  const client = getClient(db, clientId);
  const next = {
    name: client.name,
    phone: client.phone,
    discount_percent: client.discount_percent,
    note: client.note,
  };
  if ("name" in patch) {
    next.name = String(patch.name ?? "").trim();
    if (!next.name) throw new ConflictError("Имя клиента не может быть пустым");
  }
  if ("phone" in patch) next.phone = String(patch.phone ?? "").trim() || null;
  if ("note" in patch) next.note = String(patch.note ?? "").trim() || null;
  if ("discount_percent" in patch) {
    const d = Number(patch.discount_percent);
    if (!Number.isInteger(d) || d < 0 || d > 100) {
      throw new ConflictError("Скидка должна быть целым числом 0–100");
    }
    next.discount_percent = d;
  }
  db.prepare(
    "UPDATE clients SET name = ?, phone = ?, discount_percent = ?, note = ? WHERE id = ?"
  ).run(next.name, next.phone, next.discount_percent, next.note, client.id);
  return getClient(db, client.id);
}
