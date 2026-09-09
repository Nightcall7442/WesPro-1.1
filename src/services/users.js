// Аккаунты сотрудников: администраторы и кассиры.
// Пароли хранятся как scrypt-хэши (node:crypto), исходный пароль
// нигде не сохраняется.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { utcNow } from "../db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";

// developer — разработчик (полный доступ всегда, не ограничивается матрицей
// прав — иначе можно было бы случайно заблокировать себе вход насовсем);
// owner — владелец клуба; manager — управляющий; admin — администратор;
// cashier — кассир.
export const ROLES = ["developer", "owner", "manager", "admin", "cashier"];
export const ROLE_LABELS = {
  developer: "Разработчик",
  owner: "Владелец",
  manager: "Управляющий",
  admin: "Администратор",
  cashier: "Кассир",
};
// Роли, гарантированно имеющие управленческий доступ — систему нельзя
// оставить совсем без такого пользователя (см. countOtherActiveManagers).
const MANAGEMENT_ROLES = new Set(["developer", "owner", "manager", "admin"]);
// Роли developer/owner/manager может выдавать только тот, кто сам developer
// или owner — иначе администратор мог бы сам себя повысить.
const RESTRICTED_ROLES = new Set(["developer", "owner", "manager"]);
// Кто вправе выдавать роли из RESTRICTED_ROLES.
const ROLE_GRANTORS = new Set(["developer", "owner"]);

const MIN_PASSWORD_LENGTH = 4;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Публичное представление пользователя (без хэша пароля). */
export function toPublicUser(row) {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    role: row.role,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    // Оплата труда: ставка в рублях за час и процент от выручки.
    hourly_rate: (row.hourly_rate_kopecks ?? 0) / 100,
    revenue_percent: row.revenue_percent ?? 0,
  };
}

/**
 * Список сотрудников. custom_limits — признак, что у человека есть личные
 * ограничения (права отличаются от прав его роли): в таблице сотрудников
 * это видно сразу, без открытия карточки.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function listUsers(db) {
  const withLimits = new Set(
    db
      .prepare("SELECT DISTINCT user_id FROM user_permissions")
      .all()
      .map((r) => r.user_id)
  );
  return db
    .prepare("SELECT * FROM users ORDER BY id")
    .all()
    .map((row) => ({
      ...toPublicUser(row),
      custom_limits: withLimits.has(row.id),
    }));
}

export function getUser(db, userId) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!row) throw new NotFoundError(`Сотрудник id=${userId} не найден`);
  return row;
}

/**
 * Сколько активных аккаунтов вправе выдавать привилегированные роли.
 * Ноль — это первый запуск: на свежей базе есть только администратор,
 * и если запретить ему создать владельца, владельца не создать вообще.
 * Поэтому пока владельца/разработчика нет, первого создать можно; как
 * только он появился — привилегии выдаёт только он.
 */
export function countRoleGrantors(db) {
  const roles = [...ROLE_GRANTORS];
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE is_active = 1 AND role IN (${roles.map(() => "?").join(", ")})`
    )
    .get(...roles).n;
}

/**
 * Первый запуск: владельца и разработчика в системе ещё нет. В этом
 * состоянии их полномочия временно берёт на себя тот, кто управляет
 * сотрудниками — иначе владельца не создать и права не настроить.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function isOwnerSetupPending(db) {
  return countRoleGrantors(db) === 0;
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new ConflictError(
      `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`
    );
  }
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{login: string, name: string, password: string, role: string}} data
 * @param {{id: number, name: string} | null} [author] кто создаёт (для журнала)
 */
export function createUser(db, data, author = null) {
  // Логин сохраняем как его ввели — с заглавной буквы, если так набрали.
  // Регистр при входе не важен: сравнение идёт без учёта регистра.
  const login = String(data.login ?? "").trim();
  const name = String(data.name ?? "").trim();
  if (!login) throw new ConflictError("Логин не может быть пустым");
  if (!name) throw new ConflictError("Имя не может быть пустым");
  if (!ROLES.includes(data.role)) {
    throw new ConflictError(`Недопустимая роль «${data.role}»`);
  }
  // Первый владелец/разработчик создаётся в обход запрета — иначе на свежей
  // базе (там только администратор) его было бы не создать никогда.
  const firstOwnerSetup =
    ROLE_GRANTORS.has(data.role) && countRoleGrantors(db) === 0;
  if (
    RESTRICTED_ROLES.has(data.role) &&
    !ROLE_GRANTORS.has(author?.role) &&
    !firstOwnerSetup
  ) {
    throw new ConflictError(
      `Роль «${ROLE_LABELS[data.role]}» может назначить только владелец или разработчик`
    );
  }
  validatePassword(data.password);
  if (
    db
      .prepare("SELECT id FROM users WHERE login = ? COLLATE NOCASE")
      .get(login)
  ) {
    throw new ConflictError(`Логин «${login}» уже занят`);
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO users (login, name, password_hash, role, is_active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    )
    .run(login, name, hashPassword(data.password), data.role, utcNow());
  const user = getUser(db, Number(lastInsertRowid));
  logEvent(
    db,
    JournalEvent.USER_CREATED,
    `Создан сотрудник «${name}» (${login}, ${ROLE_LABELS[data.role]})` +
      (author ? ` — ${author.name}` : "")
  );
  return toPublicUser(user);
}

function countOtherActiveManagers(db, exceptUserId) {
  const roles = [...MANAGEMENT_ROLES];
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE role IN (${roles.map(() => "?").join(", ")})
         AND is_active = 1 AND id != ?`
    )
    .get(...roles, exceptUserId).n;
}

/**
 * Обновление сотрудника: логин, имя, роль, активность, сброс пароля.
 * Нельзя оставить систему без активного управленческого аккаунта, нельзя
 * деактивировать самого себя и понизить себе роль до кассира.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} userId
 * @param {{login?: string, name?: string, role?: string, is_active?: boolean, password?: string}} patch
 * @param {{id: number, name: string, role: string}} author
 */
export function updateUser(db, userId, patch, author) {
  const user = getUser(db, userId);

  const next = {
    login: user.login,
    name: user.name,
    role: user.role,
    is_active: Boolean(user.is_active),
    password_hash: user.password_hash,
    hourly_rate_kopecks: user.hourly_rate_kopecks ?? 0,
    revenue_percent: user.revenue_percent ?? 0,
  };
  if ("login" in patch) {
    next.login = String(patch.login ?? "").trim();
    if (!next.login) throw new ConflictError("Логин не может быть пустым");
    const taken = db
      .prepare("SELECT id FROM users WHERE login = ? COLLATE NOCASE AND id != ?")
      .get(next.login, user.id);
    if (taken) throw new ConflictError(`Логин «${next.login}» уже занят`);
  }
  if ("name" in patch) {
    next.name = String(patch.name ?? "").trim();
    if (!next.name) throw new ConflictError("Имя не может быть пустым");
  }
  if ("role" in patch) {
    if (!ROLES.includes(patch.role)) {
      throw new ConflictError(`Недопустимая роль «${patch.role}»`);
    }
    // Та же поблажка, что при создании: первого владельца можно назначить
    // и из администратора — пока владельца/разработчика в системе нет.
    const firstOwnerSetup =
      ROLE_GRANTORS.has(patch.role) && countRoleGrantors(db) === 0;
    if (
      patch.role !== user.role &&
      (RESTRICTED_ROLES.has(patch.role) || RESTRICTED_ROLES.has(user.role)) &&
      !ROLE_GRANTORS.has(author.role) &&
      !firstOwnerSetup
    ) {
      throw new ConflictError(
        `Менять роль «${ROLE_LABELS[patch.role]}» может только владелец или разработчик`
      );
    }
    next.role = patch.role;
  }
  if ("is_active" in patch) next.is_active = Boolean(patch.is_active);
  if ("hourly_rate" in patch) {
    const rate = Number(patch.hourly_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1_000_000) {
      throw new ConflictError("Ставка за час: число от 0 до 1 000 000");
    }
    next.hourly_rate_kopecks = Math.round(rate * 100);
  }
  if ("revenue_percent" in patch) {
    const percent = Number(patch.revenue_percent);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new ConflictError("Процент от выручки: целое число 0–100");
    }
    next.revenue_percent = percent;
  }
  if ("password" in patch && patch.password !== "") {
    validatePassword(patch.password);
    next.password_hash = hashPassword(patch.password);
  }

  const losesManagement =
    MANAGEMENT_ROLES.has(user.role) &&
    user.is_active &&
    (!MANAGEMENT_ROLES.has(next.role) || !next.is_active);
  if (losesManagement && countOtherActiveManagers(db, user.id) === 0) {
    throw new ConflictError(
      "Нельзя оставить систему без активного управленческого аккаунта " +
        "(разработчик, владелец, управляющий или администратор)"
    );
  }
  if (!next.is_active && user.id === author.id) {
    throw new ConflictError("Нельзя деактивировать собственный аккаунт");
  }
  if (user.id === author.id && next.role !== user.role) {
    throw new ConflictError("Нельзя менять роль собственного аккаунта");
  }

  db.prepare(
    `UPDATE users SET login = ?, name = ?, role = ?, is_active = ?, password_hash = ?,
       hourly_rate_kopecks = ?, revenue_percent = ?
     WHERE id = ?`
  ).run(
    next.login,
    next.name,
    next.role,
    next.is_active ? 1 : 0,
    next.password_hash,
    next.hourly_rate_kopecks,
    next.revenue_percent,
    user.id
  );

  logEvent(
    db,
    JournalEvent.USER_UPDATED,
    `Обновлён сотрудник «${next.name}» (${next.login}, ${ROLE_LABELS[next.role]})` +
      ` — ${author.name}`
  );
  return toPublicUser(getUser(db, user.id));
}

/** Сколько записей ссылается на сотрудника (смены, сеансы, заказы, брони). */
function countUserReferences(db, userId) {
  const queries = [
    "SELECT COUNT(*) AS n FROM shifts WHERE user_id = ?",
    "SELECT COUNT(*) AS n FROM table_sessions WHERE opened_by = ? OR closed_by = ?",
    "SELECT COUNT(*) AS n FROM session_orders WHERE created_by = ?",
    "SELECT COUNT(*) AS n FROM bookings WHERE created_by = ?",
  ];
  let total = 0;
  for (const sql of queries) {
    const params = sql.includes("closed_by") ? [userId, userId] : [userId];
    total += db.prepare(sql).get(...params).n;
  }
  return total;
}

/**
 * Удаление сотрудника. Если за ним есть история (смены, сеансы, заказы,
 * брони) — аккаунт не удаляется физически (это сломало бы историю), а
 * отключается: вход закрыт, а записи остаются с его именем.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} userId
 * @param {{id: number, name: string, role: string}} author
 * @returns {{deleted: boolean, user: ReturnType<typeof toPublicUser>}}
 */
export function deleteUser(db, userId, author) {
  const user = getUser(db, userId);
  if (user.id === author.id) {
    throw new ConflictError("Нельзя удалить собственный аккаунт");
  }
  if (RESTRICTED_ROLES.has(user.role) && !ROLE_GRANTORS.has(author.role)) {
    throw new ConflictError(
      `Удалить сотрудника с ролью «${ROLE_LABELS[user.role]}» может только владелец или разработчик`
    );
  }
  if (
    MANAGEMENT_ROLES.has(user.role) &&
    user.is_active &&
    countOtherActiveManagers(db, user.id) === 0
  ) {
    throw new ConflictError(
      "Нельзя удалить последний управленческий аккаунт " +
        "(разработчик, владелец, управляющий или администратор)"
    );
  }

  const hasHistory = countUserReferences(db, user.id) > 0;
  if (hasHistory) {
    db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(user.id);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
    logEvent(
      db,
      JournalEvent.USER_DELETED,
      `Сотрудник «${user.name}» (${user.login}) отключён — за ним есть история, ` +
        `аккаунт сохранён — ${author.name}`
    );
    return { deleted: false, user: toPublicUser(getUser(db, user.id)) };
  }

  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  logEvent(
    db,
    JournalEvent.USER_DELETED,
    `Удалён сотрудник «${user.name}» (${user.login}) — ${author.name}`
  );
  return { deleted: true, user: toPublicUser(user) };
}

/**
 * Проверка логина и пароля. Возвращает публичного пользователя или null.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function authenticate(db, login, password) {
  // Регистр логина при входе не важен: «Admin» и «admin» — один аккаунт.
  const row = db
    .prepare("SELECT * FROM users WHERE login = ? COLLATE NOCASE AND is_active = 1")
    .get(String(login ?? "").trim());
  if (!row) return null;
  if (!verifyPassword(String(password ?? ""), row.password_hash)) return null;
  return toPublicUser(row);
}

/** Смена собственного пароля (требует старый пароль). */
export function changeOwnPassword(db, userId, oldPassword, newPassword) {
  const user = getUser(db, userId);
  if (!verifyPassword(String(oldPassword ?? ""), user.password_hash)) {
    throw new ConflictError("Текущий пароль указан неверно");
  }
  validatePassword(newPassword);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    hashPassword(newPassword),
    user.id
  );
}
