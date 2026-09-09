// Права ролей: настраиваемая матрица «роль × право» с разумными
// значениями по умолчанию. Роль developer в матрице не хранится и не
// показывается — у неё всегда полный доступ, это страховка на случай,
// если кто-то случайно уберёт все права у всех остальных ролей.

import { ConflictError } from "./errors.js";

// hidden: право остаётся в системе (API его проверяет), но в редакторе
// «Роли и права» не показывается — так спрятан выключенный бар.
export const PERMISSIONS = [
  { key: "manage_tables", label: "Столы: добавление, удаление, тарифы стола, устройства" },
  { key: "manage_tariffs", label: "Тарифы: создание, изменение, удаление, расписания" },
  { key: "manage_bar", label: "Меню бара", hidden: true },
  { key: "manage_clients", label: "Клиенты: скидки" },
  { key: "manage_users", label: "Сотрудники: аккаунты, роли, удаление" },
  { key: "manage_settings", label: "Настройки клуба, план зала, освещение, база данных" },
  { key: "view_reports", label: "Отчёты, статистика, экспорт" },
  { key: "view_shifts", label: "Смены всех кассиров (не только своя)" },
  { key: "view_journal", label: "Журнал событий" },
  { key: "open_free_time", label: "Открытие бесплатного времени" },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

// Роли, для которых матрица применяется. developer сюда не входит —
// у него доступ всегда полный, в обход этой таблицы.
const EDITABLE_ROLES = ["owner", "manager", "admin", "cashier"];

// Значения по умолчанию, пока владелец их не поменял в настройках.
// manager (управляющий) — «правая рука владельца»: по умолчанию всё, кроме
// редактора самих прав (он вообще не через матрицу, а жёстко по роли).
// admin получает всё как раньше (обратная совместимость), кроме бесплатного
// времени — это отдельная владельческая привилегия.
const DEFAULTS = {
  owner: Object.fromEntries(PERMISSIONS.map((p) => [p.key, true])),
  manager: Object.fromEntries(PERMISSIONS.map((p) => [p.key, true])),
  admin: Object.fromEntries(
    PERMISSIONS.map((p) => [p.key, p.key !== "open_free_time"])
  ),
  cashier: Object.fromEntries(PERMISSIONS.map((p) => [p.key, false])),
};

function defaultFor(role, key) {
  return DEFAULTS[role]?.[key] ?? false;
}

/**
 * Право по роли (без личных ограничений сотрудника).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} role
 * @param {string} key
 */
export function hasPermission(db, role, key) {
  if (role === "developer") return true;
  if (!PERMISSION_KEYS.has(key)) return false;
  const row = db
    .prepare("SELECT allowed FROM role_permissions WHERE role = ? AND permission = ?")
    .get(role, key);
  return row ? Boolean(row.allowed) : defaultFor(role, key);
}

/**
 * Право конкретного сотрудника: личное ограничение сильнее роли.
 * Так «этому кассиру скидки можно, а тому нельзя» решается без создания
 * отдельных ролей под каждого человека.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, role: string} | null | undefined} user
 * @param {string} key
 */
export function userCan(db, user, key) {
  if (!user) return false;
  if (user.role === "developer") return true; // полный доступ всегда
  if (!PERMISSION_KEYS.has(key)) return false;
  const own = db
    .prepare("SELECT allowed FROM user_permissions WHERE user_id = ? AND permission = ?")
    .get(user.id, key);
  if (own) return Boolean(own.allowed);
  return hasPermission(db, user.role, key);
}

/**
 * Права сотрудника одним объектом — удобно отдать на фронтенд.
 * Принимает пользователя целиком (тогда учитываются личные ограничения)
 * или просто роль — так вызывали раньше.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, role: string} | string} userOrRole
 */
export function permissionsForUser(db, userOrRole) {
  const user =
    typeof userOrRole === "string" ? null : userOrRole;
  const role = typeof userOrRole === "string" ? userOrRole : userOrRole?.role;
  return Object.fromEntries(
    PERMISSIONS.map((p) => [
      p.key,
      user ? userCan(db, user, p.key) : hasPermission(db, role, p.key),
    ])
  );
}

/**
 * Личные ограничения сотрудника для редактора: по каждому праву —
 * что даёт роль и что решили лично («по роли» = записи нет).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, role: string}} user
 */
export function getUserPermissionOverrides(db, user) {
  const rows = db
    .prepare("SELECT permission, allowed FROM user_permissions WHERE user_id = ?")
    .all(user.id);
  const own = new Map(rows.map((r) => [r.permission, Boolean(r.allowed)]));
  return {
    permissions: PERMISSIONS.filter((p) => !p.hidden).map((p) => ({
      key: p.key,
      label: p.label,
      by_role: hasPermission(db, user.role, p.key),
      // null — личного решения нет, действует право роли
      own: own.has(p.key) ? own.get(p.key) : null,
      effective: userCan(db, user, p.key),
    })),
    role: user.role,
    // У разработчика доступ полный всегда, личные ограничения к нему не
    // применяются — редактор должен это показать, а не врать.
    ignored: user.role === "developer",
  };
}

/**
 * Сохраняет личные ограничения: {ключ: true | false | null}.
 * null (или "role") — убрать личное решение, вернуться к праву роли.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, role: string}} user
 * @param {Record<string, boolean | null | "role">} entries
 */
export function setUserPermissionOverrides(db, user, entries) {
  if (!entries || typeof entries !== "object") {
    throw new ConflictError("Ожидался набор прав");
  }
  const upsert = db.prepare(
    `INSERT INTO user_permissions (user_id, permission, allowed) VALUES (?, ?, ?)
     ON CONFLICT (user_id, permission) DO UPDATE SET allowed = excluded.allowed`
  );
  const remove = db.prepare(
    "DELETE FROM user_permissions WHERE user_id = ? AND permission = ?"
  );
  for (const [key, value] of Object.entries(entries)) {
    if (!PERMISSION_KEYS.has(key)) {
      throw new ConflictError(`Недопустимое право «${key}»`);
    }
    if (value === null || value === "role" || value === undefined) {
      remove.run(user.id, key);
    } else {
      upsert.run(user.id, key, value ? 1 : 0);
    }
  }
  return getUserPermissionOverrides(db, user);
}

/** Вся матрица «роль × право» для редактора в настройках (без скрытых прав). */
export function getPermissionMatrix(db) {
  const rows = db.prepare("SELECT role, permission, allowed FROM role_permissions").all();
  const overrides = new Map(rows.map((r) => [`${r.role}:${r.permission}`, Boolean(r.allowed)]));
  const visible = PERMISSIONS.filter((p) => !p.hidden);
  const matrix = {};
  for (const role of EDITABLE_ROLES) {
    matrix[role] = {};
    for (const { key } of visible) {
      matrix[role][key] = overrides.has(`${role}:${key}`)
        ? overrides.get(`${role}:${key}`)
        : defaultFor(role, key);
    }
  }
  return { permissions: visible, roles: EDITABLE_ROLES, matrix };
}

/**
 * Массово сохраняет права: [{role, permission, allowed}, ...].
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {Array<{role: string, permission: string, allowed: boolean}>} entries
 */
export function setPermissions(db, entries) {
  if (!Array.isArray(entries)) {
    throw new ConflictError("Ожидался список прав");
  }
  const stmt = db.prepare(
    `INSERT INTO role_permissions (role, permission, allowed) VALUES (?, ?, ?)
     ON CONFLICT (role, permission) DO UPDATE SET allowed = excluded.allowed`
  );
  for (const entry of entries) {
    if (!EDITABLE_ROLES.includes(entry.role)) {
      throw new ConflictError(`Недопустимая роль «${entry.role}»`);
    }
    if (!PERMISSION_KEYS.has(entry.permission)) {
      throw new ConflictError(`Недопустимое право «${entry.permission}»`);
    }
    stmt.run(entry.role, entry.permission, entry.allowed ? 1 : 0);
  }
  return getPermissionMatrix(db);
}
