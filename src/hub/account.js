// Личный кабинет владельца клуба: самостоятельная регистрация на сайте
// и вход по почте и паролю.
//
// Это НЕ то же самое, что вход в панель сети (src/hub/auth.js — им
// пользуются сотрудники WesPro) и НЕ то же самое, что вход в саму
// программу клуба (src/services/auth.js — логин/пароль сотрудника на
// месте). Здесь третий, отдельный вид входа: клиент сервиса видит только
// карточку своего клуба — статус подписки, историю оплат и ключ доступа,
// который дальше вписывается в программу клуба.

import { randomBytes } from "node:crypto";

import { hashPassword, verifyPassword } from "../services/users.js";
import { ConflictError, UnauthorizedError } from "../services/errors.js";
import { clubRow, createClub, getClub, listPayments } from "./clubs.js";

export const ACCOUNT_COOKIE_NAME = "wespro_club_session";
const SESSION_DAYS = 30;

const now = () => new Date().toISOString();
const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

// Простая, но осмысленная проверка формата — не пускать явный мусор,
// не изображать полноценную валидацию почты (это дело подтверждения
// письмом, которого здесь пока нет).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
  const value = normalizeEmail(email);
  if (!EMAIL_RE.test(value)) {
    throw new ConflictError("Введите настоящий адрес почты");
  }
  return value;
}

function validatePassword(password) {
  const value = String(password ?? "");
  if (value.length < 8) {
    throw new ConflictError("Пароль: минимум 8 символов");
  }
  return value;
}

/**
 * Регистрация клуба на сайте: название клуба, ФИО владельца, почта и
 * пароль. Заводит клуб с тем же пробным периодом, что и при ручном
 * добавлении в панели — разницы для подписки нет, разница только в том,
 * кто нажал кнопку «Создать».
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{name: string, owner_name: string, email: string, password: string}} data
 */
export function registerClub(db, data) {
  const email = validateEmail(data?.email);
  const password = validatePassword(data?.password);
  const ownerName = String(data?.owner_name ?? "").trim();
  if (ownerName.length < 2) {
    throw new ConflictError("Укажите имя и фамилию — минимум 2 символа");
  }
  if (db.prepare("SELECT id FROM clubs WHERE email = ?").get(email)) {
    throw new ConflictError(`Клуб с почтой «${email}» уже зарегистрирован`);
  }

  // Название клуба проверяет createClub (уникальность, длина) — здесь
  // дублировать нечего, ошибка долетит до вызывающего как есть.
  const club = createClub(db, { name: data?.name, owner_name: ownerName, email });
  db.prepare("UPDATE clubs SET password_hash = ? WHERE id = ?").run(
    hashPassword(password),
    club.id
  );
  return club;
}

/**
 * Проверяет почту и пароль. Клубам, заведённым вручную без пароля
 * (password_hash пуст), вход по почте недоступен — им нужно, чтобы
 * владелец сервиса выдал доступ, либо самим зарегистрироваться заново
 * этой же почтой (регистрация её всё равно займёт).
 */
export function authenticateClub(db, email, password) {
  const row = db
    .prepare("SELECT * FROM clubs WHERE email = ? AND status <> 'archived'")
    .get(normalizeEmail(email));
  if (!row || !row.password_hash) return null;
  if (!verifyPassword(String(password ?? ""), row.password_hash)) return null;
  return row;
}

export function createClubSession(db, clubId) {
  const token = randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO club_sessions (token, club_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(token, clubId, now(), new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  return token;
}

/** Клуб по токену сессии кабинета (или null: нет токена, истёк, клуб в архиве). */
export function clubByToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT c.*, s.expires_at FROM club_sessions s
         JOIN clubs c ON c.id = s.club_id
        WHERE s.token = ? AND c.status <> 'archived'`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at <= now()) {
    db.prepare("DELETE FROM club_sessions WHERE token = ?").run(token);
    return null;
  }
  return row;
}

export function deleteClubSession(db, token) {
  if (token) db.prepare("DELETE FROM club_sessions WHERE token = ?").run(token);
}

export function accountSessionCookie(token) {
  return (
    `${ACCOUNT_COOKIE_NAME}=${token}; HttpOnly; Path=/account; SameSite=Lax; ` +
    `Max-Age=${SESSION_DAYS * 86400}`
  );
}

export function clearedAccountSessionCookie() {
  return `${ACCOUNT_COOKIE_NAME}=; HttpOnly; Path=/account; SameSite=Lax; Max-Age=0`;
}

export function accountTokenFromCookie(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCOUNT_COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

/**
 * Смена пароля из кабинета — попросили старый пароль, чтобы чужой,
 * получивший на минуту открытый браузер, не мог перехватить кабинет.
 */
export function changeClubPassword(db, clubId, oldPassword, newPassword) {
  clubRow(db, clubId); // бросит NotFoundError, если клуба уже нет
  // clubRow() пароль намеренно не отдаёт (чтобы хэш не утёк туда, где
  // используется её обычный, «публичный» результат) — здесь читаем сами.
  const { password_hash } = db
    .prepare("SELECT password_hash FROM clubs WHERE id = ?")
    .get(clubId);
  if (!password_hash || !verifyPassword(String(oldPassword ?? ""), password_hash)) {
    throw new UnauthorizedError("Неверный текущий пароль");
  }
  const password = validatePassword(newPassword);
  db.prepare("UPDATE clubs SET password_hash = ? WHERE id = ?").run(
    hashPassword(password),
    clubId
  );
  return { ok: true };
}

/** Данные для личного кабинета: карточка клуба + история его оплат. */
export function accountView(db, clubId) {
  return {
    club: getClub(db, clubId),
    payments: listPayments(db, clubId),
  };
}
