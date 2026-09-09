// Создание аккаунта сотрудника прямо на компьютере клуба, без входа в
// программу. Нужно для двух случаев:
//   1. Завести аккаунт разработчика (полный доступ всегда) — его нельзя
//      выдать себе из интерфейса, если владельца ещё нет.
//   2. Восстановить доступ, когда пароли забыты: у того, кто сидит за
//      компьютером с базой, права и так максимальные.
//
// Запуск: npm run add-user -- --role developer
//         npm run add-user -- --login dev --name "Разработчик" --password секрет
// Из Windows удобнее двойным щелчком по create-developer.bat.

import { randomInt } from "node:crypto";

import { createDatabase } from "../db.js";
import { DATABASE_PATH } from "../config.js";
import { ROLES, ROLE_LABELS, createUser, updateUser } from "../services/users.js";

// Без похожих друг на друга знаков (0/O, 1/l/I) — пароль придётся
// диктовать и вводить руками.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
const GENERATED_LENGTH = 12;

/** Пароль, который не стыдно оставить у аккаунта с полным доступом. */
export function generatePassword(length = GENERATED_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

/** Разбор аргументов вида --ключ значение. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

// Действие выполняется за компьютером, где лежит база: это заведомо
// хозяин установки, поэтому ограничения «роль выдаёт только владелец»
// здесь не применяются (в журнале так и пишем).
const CLI_AUTHOR = {
  id: null,
  name: "Настройка на компьютере клуба",
  role: "developer",
};

/**
 * Создаёт аккаунт (или обновляет пароль и роль существующего).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{login: string, name?: string, role?: string, password?: string}} options
 */
export function addUser(db, options) {
  const login = String(options.login ?? "").trim();
  const role = String(options.role ?? "developer");
  if (!login) throw new Error("Не указан логин (--login)");
  if (!ROLES.includes(role)) {
    throw new Error(
      `Неизвестная роль «${role}». Доступны: ${ROLES.join(", ")}`
    );
  }
  const password = options.password ? String(options.password) : generatePassword();
  const name = String(options.name ?? "").trim() || ROLE_LABELS[role];

  const existing = db
    .prepare("SELECT id, login FROM users WHERE login = ? COLLATE NOCASE")
    .get(login);
  if (existing) {
    // Логин занят — не плодим второй аккаунт, а возвращаем доступ к этому:
    // новая роль, новый пароль, вход разрешён.
    updateUser(
      db,
      existing.id,
      { name, role, password, is_active: true },
      CLI_AUTHOR
    );
    return { login, password, role, name, created: false };
  }

  createUser(db, { login, name, password, role }, CLI_AUTHOR);
  return { login, password, role, name, created: true };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const role = args.role === true || !args.role ? "developer" : String(args.role);
  const login = args.login === true || !args.login ? "dev" : String(args.login);
  const password =
    args.password === true || !args.password ? undefined : String(args.password);

  const db = createDatabase();
  let result;
  try {
    result = addUser(db, { login, name: args.name, role, password });
  } catch (error) {
    console.error(`\nНе получилось: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const line = "=".repeat(58);
  console.log(`\n${line}`);
  console.log(
    result.created
      ? `  Аккаунт создан: ${ROLE_LABELS[result.role]}`
      : `  Аккаунт обновлён (логин уже был): ${ROLE_LABELS[result.role]}`
  );
  console.log(line);
  console.log(`  Логин:  ${result.login}`);
  console.log(`  Пароль: ${result.password}`);
  console.log(line);
  console.log("  Запишите пароль — второй раз он не покажется.");
  if (result.role === "developer") {
    console.log("  У разработчика полный доступ всегда, в обход настроек прав.");
  }
  console.log(`  База: ${DATABASE_PATH}`);
  console.log(`${line}\n`);
}

// Запуск напрямую (а не импорт из тестов).
if (process.argv[1] && process.argv[1].endsWith("add-user.js")) {
  main();
}
