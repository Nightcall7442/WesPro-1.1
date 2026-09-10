// Вход в центральную панель. Отдельно от входа в клуб: другая база,
// другая cookie, другие учётки. Сотрудник клуба сюда попасть не должен
// даже случайно, поэтому ничего общего с сессиями клуба здесь нет.

import { randomBytes } from "node:crypto";

import { hashPassword, verifyPassword } from "../services/users.js";
import { ConflictError, NotFoundError } from "../services/errors.js";
import { HubEvent, logHubEvent } from "./journal.js";

export const HUB_COOKIE_NAME = "wespro_hub_session";
const SESSION_DAYS = 14;

const now = () => new Date().toISOString();

function toPublic(row) {
  return { id: row.id, login: row.login, name: row.name, is_active: Boolean(row.is_active) };
}

/**
 * Заводит владельца сервиса при первом запуске, если панель пустая.
 * Пароль по умолчанию в коде для панели, где лежат все клубы, держать
 * нельзя, поэтому он либо берётся из окружения (WESPRO_HUB_PASSWORD),
 * либо генерируется и печатается в консоль один раз.
 *
 * Если WESPRO_HUB_PASSWORD задана, она задаёт пароль и уже заведённому
 * владельцу. Иначе панель становилась недоступна навсегда: пароль
 * печатался единственный раз при самом первом запуске, и на хостинге,
 * где логи давно уехали, войти было уже нечем.
 *
 * @returns {{login: string, password: string, generated: boolean, reset: boolean} | null}
 *   что показать в консоли (null — ничего не меняли)
 */
export function seedHubOwner(db) {
  const login = String(process.env.WESPRO_HUB_LOGIN ?? "owner").trim().toLowerCase();
  const forced = process.env.WESPRO_HUB_PASSWORD;
  const existing = db.prepare("SELECT id FROM hub_users WHERE login = ?").get(login);

  if (existing) {
    if (!forced) return null;
    db.prepare("UPDATE hub_users SET password_hash = ?, is_active = 1 WHERE id = ?").run(
      hashPassword(forced),
      existing.id
    );
    return { login, password: forced, generated: false, reset: true };
  }
  // Панель уже с людьми, а этого логина в ней нет: молча заводить ещё
  // одного владельца — не наше дело, их добавляют внутри панели.
  if (!forced && db.prepare("SELECT id FROM hub_users LIMIT 1").get()) return null;

  const password = forced ?? randomBytes(6).toString("hex");
  db.prepare(
    "INSERT INTO hub_users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(login, "Владелец сервиса", hashPassword(password), now());
  return { login, password, generated: !forced, reset: false };
}

export function listHubUsers(db) {
  return db.prepare("SELECT * FROM hub_users ORDER BY login").all().map(toPublic);
}

export function createHubUser(db, data) {
  const login = String(data?.login ?? "").trim().toLowerCase();
  const name = String(data?.name ?? "").trim();
  const password = String(data?.password ?? "");
  if (login.length < 3) throw new ConflictError("Логин: минимум 3 символа");
  if (name.length < 2) throw new ConflictError("Имя: минимум 2 символа");
  if (password.length < 8) throw new ConflictError("Пароль: минимум 8 символов");
  if (db.prepare("SELECT id FROM hub_users WHERE login = ?").get(login)) {
    throw new ConflictError(`Логин «${login}» уже занят`);
  }
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO hub_users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(login, name, hashPassword(password), now());
  return toPublic(db.prepare("SELECT * FROM hub_users WHERE id = ?").get(Number(lastInsertRowid)));
}

export function setHubUserPassword(db, userId, password) {
  const row = db.prepare("SELECT * FROM hub_users WHERE id = ?").get(userId);
  if (!row) throw new NotFoundError(`Сотрудник id=${userId} не найден`);
  if (String(password ?? "").length < 8) {
    throw new ConflictError("Пароль: минимум 8 символов");
  }
  db.prepare("UPDATE hub_users SET password_hash = ? WHERE id = ?").run(
    hashPassword(String(password)),
    userId
  );
  return toPublic(row);
}

/** Проверяет логин и пароль; null — не подошло. */
export function authenticateHubUser(db, login, password) {
  const row = db
    .prepare("SELECT * FROM hub_users WHERE login = ? AND is_active = 1")
    .get(String(login ?? "").trim().toLowerCase());
  if (!row) return null;
  if (!verifyPassword(String(password ?? ""), row.password_hash)) return null;
  logHubEvent(db, HubEvent.HUB_LOGIN, `Вход в панель: ${row.name}`);
  return toPublic(row);
}

export function createHubSession(db, userId) {
  const token = randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO hub_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, now(), new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  return token;
}

export function hubUserByToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at FROM hub_sessions s
         JOIN hub_users u ON u.id = s.user_id
        WHERE s.token = ? AND u.is_active = 1`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at <= now()) {
    db.prepare("DELETE FROM hub_sessions WHERE token = ?").run(token);
    return null;
  }
  return toPublic(row);
}

export function deleteHubSession(db, token) {
  if (token) db.prepare("DELETE FROM hub_sessions WHERE token = ?").run(token);
}

export function hubSessionCookie(token) {
  return (
    `${HUB_COOKIE_NAME}=${token}; HttpOnly; Path=/hub; SameSite=Lax; ` +
    `Max-Age=${SESSION_DAYS * 86400}`
  );
}

export function clearedHubSessionCookie() {
  return `${HUB_COOKIE_NAME}=; HttpOnly; Path=/hub; SameSite=Lax; Max-Age=0`;
}

export function hubTokenFromCookie(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === HUB_COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}
