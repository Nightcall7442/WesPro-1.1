// Начальные данные для пустой базы: при первом запуске (нет ни столов,
// ни тарифов) создаём стартовый набор, чтобы клуб мог работать сразу.
// На непустую базу не влияет.

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

  const hasTables = db.prepare("SELECT id FROM tables LIMIT 1").get();
  const hasTariffs = db.prepare("SELECT id FROM tariffs LIMIT 1").get();
  if (hasTables || hasTariffs) return;
  for (const name of INITIAL_TABLES) createTable(db, name);
  for (const [name, price] of INITIAL_TARIFFS) createTariff(db, name, price);
}
