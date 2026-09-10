// Начальные данные для пустой базы: при первом запуске (нет ни столов,
// ни тарифов) создаём стартовый набор, чтобы клуб мог работать сразу.
// На непустую базу не влияет.

import { utcNow } from "./db.js";
import { createTable } from "./services/tables.js";
import { createTariff } from "./services/tariffs.js";
import { createUser } from "./services/users.js";

const INITIAL_TABLES = ["Стол 1", "Стол 2", "Стол 3"];
const INITIAL_TARIFFS = [
  ["Будний день", 400],
  ["Выходной день", 600],
];

export const INITIAL_ADMIN = { login: "admin", password: "admin", name: "Администратор" };

/** @param {import("node:sqlite").DatabaseSync} db */
export function seedInitialData(db) {
  // Первый администратор — создаётся на пустой базе пользователей,
  // независимо от столов и тарифов.
  if (!db.prepare("SELECT id FROM users LIMIT 1").get()) {
    createUser(db, { ...INITIAL_ADMIN, role: "admin" });
    console.warn(
      `Создан администратор по умолчанию: логин «${INITIAL_ADMIN.login}», ` +
        `пароль «${INITIAL_ADMIN.password}» — смените пароль после первого входа!`
    );
  }

  seedTablesAndTariffs(db);
}

/** @param {import("node:sqlite").DatabaseSync} db */
function seedTablesAndTariffs(db) {
  const hasTables = db.prepare("SELECT id FROM tables LIMIT 1").get();
  const hasTariffs = db.prepare("SELECT id FROM tariffs LIMIT 1").get();
  if (hasTables || hasTariffs) return;
  for (const name of INITIAL_TABLES) createTable(db, name);
  for (const [name, price] of INITIAL_TARIFFS) createTariff(db, name, price);
}

/**
 * Стартовые данные клуба сети: те же столы и тарифы, но вместо
 * администратора «admin/admin» — владелец с почтой и паролем, которыми
 * он зарегистрировался. Пароль по умолчанию в сети недопустим: сюда
 * ведёт публичный адрес, и такой аккаунт открыт всему интернету.
 *
 * Хэш пароля берётся готовым из карточки клуба — один и тот же пароль
 * пускает и в личный кабинет, и в программу, а сам пароль при этом
 * нигде не хранится и никуда не передаётся.
 *
 * @param {import("node:sqlite").DatabaseSync} db база клуба
 * @param {{login: string, name: string, password_hash: string}} owner
 */
export function seedNetworkClub(db, owner) {
  if (!db.prepare("SELECT id FROM users LIMIT 1").get()) {
    db.prepare(
      `INSERT INTO users (login, name, password_hash, role, is_active, created_at)
       VALUES (?, ?, ?, 'owner', 1, ?)`
    ).run(owner.login, owner.name, owner.password_hash, utcNow());
  }
  seedTablesAndTariffs(db);
}
