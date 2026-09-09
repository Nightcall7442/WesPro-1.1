// Сессии входа: токен в HttpOnly-cookie, запись в таблице auth_sessions.
// Хранение в базе переживает перезапуск сервера.

import { randomBytes } from "node:crypto";

import { utcNow } from "../db.js";
import { toPublicUser } from "./users.js";

export const COOKIE_NAME = "billiards_session";
const SESSION_DAYS = 30;

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
      `SELECT u.*, s.expires_at FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND u.is_active = 1`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at <= utcNow()) {
    db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
    return null;
  }
  return toPublicUser(row);
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
