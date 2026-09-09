// Сообщения клубам и вход поддержки «от лица клуба».
//
// Сообщение не «отправляется» по сети — оно кладётся сюда, а программа
// клуба забирает его, когда отмечается на связи. Так рассылка доходит и
// до клуба, который в момент отправки был выключен: он получит её при
// первом же включении.

import { randomBytes } from "node:crypto";

import { ConflictError, NotFoundError } from "../services/errors.js";
import { clubRow } from "./clubs.js";
import { HubEvent, logHubEvent } from "./journal.js";

const now = () => new Date().toISOString();
const SUPPORT_TOKEN_MINUTES = 30;

/**
 * Создаёт сообщение: одному клубу (clubId) или всем сразу (null).
 * @param {{title: string, body: string, club_id?: number | null}} data
 */
export function createMessage(db, data, author = null) {
  const title = String(data?.title ?? "").trim();
  const body = String(data?.body ?? "").trim();
  if (title.length < 2) throw new ConflictError("Заголовок: минимум 2 символа");
  if (!body) throw new ConflictError("Текст сообщения не может быть пустым");
  const clubId =
    data?.club_id === undefined || data.club_id === null || data.club_id === ""
      ? null
      : Number(data.club_id);
  if (clubId) clubRow(db, clubId); // бросит NotFound, если клуба нет
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO hub_messages (title, body, club_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(title, body, clubId, author?.id ?? null, now());
  logHubEvent(
    db,
    HubEvent.MESSAGE_SENT,
    clubId
      ? `Сообщение клубу «${clubRow(db, clubId).name}»: ${title}`
      : `Рассылка всем клубам: ${title}`,
    clubId
  );
  return getMessage(db, Number(lastInsertRowid));
}

const MESSAGE_FIELDS = `
  m.id, m.title, m.body, m.club_id, m.created_at,
  c.name AS club_name, u.name AS author_name,
  (SELECT COUNT(*) FROM message_reads r WHERE r.message_id = m.id) AS read_count
`;

const MESSAGE_JOIN = `
  FROM hub_messages m
  LEFT JOIN clubs c ON c.id = m.club_id
  LEFT JOIN hub_users u ON u.id = m.created_by
`;

function toOut(row, totalClubs) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    club_id: row.club_id ?? null,
    club_name: row.club_name ?? null,
    author_name: row.author_name ?? null,
    read_count: row.read_count,
    // Сколько клубов вообще должны это увидеть: один или вся сеть.
    target_count: row.club_id ? 1 : totalClubs,
    created_at: row.created_at,
  };
}

function activeClubCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM clubs WHERE status <> 'archived'").get().n;
}

export function getMessage(db, messageId) {
  const row = db.prepare(`SELECT ${MESSAGE_FIELDS} ${MESSAGE_JOIN} WHERE m.id = ?`).get(messageId);
  if (!row) throw new NotFoundError(`Сообщение id=${messageId} не найдено`);
  return toOut(row, activeClubCount(db));
}

export function listMessages(db, { limit = 100 } = {}) {
  const total = activeClubCount(db);
  return db
    .prepare(
      `SELECT ${MESSAGE_FIELDS} ${MESSAGE_JOIN} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
    )
    .all(limit)
    .map((row) => toOut(row, total));
}

export function deleteMessage(db, messageId) {
  getMessage(db, messageId);
  db.prepare("DELETE FROM hub_messages WHERE id = ?").run(messageId);
  return { deleted: true };
}

/** Непрочитанные сообщения для конкретного клуба (их заберёт его программа). */
export function messagesForClub(db, clubId) {
  return db
    .prepare(
      `SELECT m.id, m.title, m.body, m.created_at
         FROM hub_messages m
        WHERE (m.club_id IS NULL OR m.club_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.club_id = ?
          )
        ORDER BY m.created_at`
    )
    .all(clubId, clubId);
}

/** Клуб подтвердил, что сообщение показано. */
export function markMessageRead(db, clubId, messageId) {
  db.prepare(
    `INSERT INTO message_reads (message_id, club_id, read_at) VALUES (?, ?, ?)
     ON CONFLICT (message_id, club_id) DO NOTHING`
  ).run(messageId, clubId, now());
  return { ok: true };
}

/**
 * Одноразовый ключ для входа «от лица клуба».
 *
 * Сам вход выполняет программа клуба: она принимает такой ключ и пускает
 * поддержку внутрь. Ключ живёт полчаса и сгорает после первого
 * использования — постоянного доступа в чужой клуб ни у кого нет.
 */
export function createSupportToken(db, clubId, reason, author = null) {
  const club = clubRow(db, clubId);
  const text = String(reason ?? "").trim();
  if (text.length < 3) {
    throw new ConflictError("Укажите причину входа — она попадёт в журнал");
  }
  const token = randomBytes(24).toString("hex");
  db.prepare(
    `INSERT INTO support_tokens (club_id, token, reason, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    clubId,
    token,
    text,
    author?.id ?? null,
    now(),
    new Date(Date.now() + SUPPORT_TOKEN_MINUTES * 60000).toISOString()
  );
  logHubEvent(
    db,
    HubEvent.SUPPORT_LOGIN,
    `Выдан ключ входа в клуб «${club.name}»: ${text}` + (author ? ` — ${author.name}` : ""),
    clubId
  );
  return { token, expires_in_minutes: SUPPORT_TOKEN_MINUTES, club_id: clubId };
}

export function listSupportLogins(db, clubId = null) {
  const where = clubId ? "WHERE t.club_id = ?" : "";
  const params = clubId ? [clubId, 100] : [100];
  return db
    .prepare(
      `SELECT t.id, t.club_id, t.reason, t.created_at, t.expires_at, t.used_at,
              c.name AS club_name, u.name AS created_by_name
         FROM support_tokens t
         LEFT JOIN clubs c ON c.id = t.club_id
         LEFT JOIN hub_users u ON u.id = t.created_by
         ${where}
        ORDER BY t.created_at DESC, t.id DESC LIMIT ?`
    )
    .all(...params);
}

/** Клуб предъявил ключ: разрешаем один раз и помечаем использованным. */
export function redeemSupportToken(db, clubId, token) {
  const row = db
    .prepare("SELECT * FROM support_tokens WHERE token = ? AND club_id = ?")
    .get(String(token ?? "").trim(), clubId);
  if (!row) throw new NotFoundError("Ключ входа не найден");
  if (row.used_at) throw new ConflictError("Этот ключ уже использован");
  if (row.expires_at <= now()) throw new ConflictError("Срок действия ключа истёк");
  db.prepare("UPDATE support_tokens SET used_at = ? WHERE id = ?").run(now(), row.id);
  logHubEvent(
    db,
    HubEvent.SUPPORT_LOGIN,
    `Поддержка вошла в клуб «${clubRow(db, clubId).name}»: ${row.reason}`,
    clubId
  );
  return { ok: true, reason: row.reason };
}
