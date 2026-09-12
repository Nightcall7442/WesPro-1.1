// Сессии входа: токен в HttpOnly-cookie, запись в таблице auth_sessions.
// Хранение в базе переживает перезапуск сервера.

import { randomBytes } from "node:crypto";

import { utcNow } from "../db.js";
import { toPublicUser } from "./users.js";

export const COOKIE_NAME = "billiards_session";
const SESSION_DAYS = 30;
// Как часто отмечать активность сессии и сколько после этого считать,
// что человек ещё в программе.
const TOUCH_EVERY_MS = 60 * 1000;
const PRESENT_FOR_MS = 10 * 60 * 1000;
/** Логины аккаунтов поддержки: support:<логин в панели сети>. */
export const SUPPORT_LOGIN_PREFIX = "support:";

/**
 * Создаёт сессию входа, возвращает токен для cookie.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} userId
 */
export function createAuthSession(db, userId) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  db.prepare(
    "INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, utcNow(), expires.toISOString());
  return token;
}

/**
 * Пользователь по токену сессии (или null: нет токена, истёк, отключён).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string | null} token
 */
export function getUserByToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at, s.last_seen_at FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND u.is_active = 1`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at <= utcNow()) {
    db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
    return null;
  }
  // Отметка активности — не чаще раза в минуту, чтобы не писать в базу
  // на каждый опрос.
  if (!row.last_seen_at || Date.parse(row.last_seen_at) < Date.now() - TOUCH_EVERY_MS) {
    db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token = ?").run(utcNow(), token);
  }
  return toPublicUser(row);
}

/**
 * Разработчик поддержки в программе прямо сейчас: сессия support-аккаунта,
 * подававшая признаки жизни последние десять минут. Клубу это показывается
 * предупреждением в шапке — чужой в программе не должен быть незаметным.
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {{name: string, since: string, seen_at: string} | null}
 */
export function supportPresence(db) {
  const row = db
    .prepare(
      `SELECT u.name, MIN(s.created_at) AS since, MAX(s.last_seen_at) AS seen_at
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE u.login LIKE ? AND s.last_seen_at >= ?
        GROUP BY u.id ORDER BY seen_at DESC LIMIT 1`
    )
    .get(`${SUPPORT_LOGIN_PREFIX}%`, new Date(Date.now() - PRESENT_FOR_MS).toISOString());
  return row ? { name: row.name, since: row.since, seen_at: row.seen_at } : null;
}

/** Завершает сессию входа (выход). */
export function deleteAuthSession(db, token) {
  if (token) db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
}

/** Значение Set-Cookie для выданного токена. */
export function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 3600;
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Значение Set-Cookie, стирающее cookie при выходе. */
export function clearedSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

/** Достаёт токен сессии из заголовка Cookie. */
export function tokenFromCookieHeader(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}
