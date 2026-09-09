// Инструменты поддержки: то, что нужно разработчику, когда клуб в другом
// городе, а разбираться приходится вам.
//
// Пакет диагностики — один текстовый файл, который клиент присылает
// вместо «у нас что-то не работает»: версия, состояние базы, сколько чего
// в таблицах, настройки без секретов, последние события и весь журнал
// ошибок. Текст, а не архив, — чтобы его можно было просто открыть и
// прочитать, не распаковывая.
//
// Секреты (пароли, токен Telegram, ключи Tuya) в пакет не попадают:
// файл уйдёт по почте или в мессенджер, и утечь он не должен.

import fs from "node:fs";
import path from "node:path";

import { DATABASE_PATH, ROOT_DIR } from "../config.js";
import { utcNow } from "../db.js";
import { diagnostics } from "./diagnostics.js";
import { listJournal } from "./journal.js";
import { getSettings } from "./settings.js";

/** Настройки, значение которых нельзя показывать. */
const SECRET_KEYS = new Set([
  "tuya_access_id",
  "tuya_access_secret",
  "telegram_bot_token",
]);
/** Логотип — это килобайты base64, в отчёте от него никакой пользы. */
const BULKY_KEYS = new Set(["club_logo"]);

const LOG_PATH = path.join(ROOT_DIR, "logs", "errors.log");
/** Журнал ошибок в отчёте обрезаем: файл бывает на сотни килобайт. */
const LOG_TAIL_BYTES = 200 * 1024;

/** Названия всех таблиц базы. */
function tableNames(db) {
  return db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((r) => r.name);
}

/** Сколько записей в каждой таблице — сразу видно, пустая база или рабочая. */
export function tableCounts(db) {
  return tableNames(db).map((name) => ({
    name,
    rows: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
  }));
}

/** Настройки без секретов и без громоздких значений. */
function safeSettings(db) {
  const settings = getSettings(db);
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_KEYS.has(key)) {
      out[key] = value ? "(задано, скрыто)" : "(пусто)";
    } else if (BULKY_KEYS.has(key)) {
      out[key] = value ? `(картинка, ${value.length} символов)` : "(пусто)";
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Сотрудники — без хэшей паролей: кто есть и какая роль. */
function staffSummary(db) {
  return db
    .prepare(
      `SELECT id, login, name, role, is_active,
              hourly_rate_kopecks, revenue_percent, created_at
       FROM users ORDER BY id`
    )
    .all();
}

function section(title, body) {
  const line = "=".repeat(64);
  return `${line}\n${title}\n${line}\n${body}\n\n`;
}

function asLines(obj) {
  return Object.entries(obj)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n");
}

/** Хвост журнала ошибок: целиком, если он небольшой. */
function errorLogTail() {
  try {
    const size = fs.statSync(LOG_PATH).size;
    const fd = fs.openSync(LOG_PATH, "r");
    try {
      const from = Math.max(0, size - LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      return (
        (from > 0 ? `… начало файла обрезано (всего ${size} байт) …\n` : "") +
        buffer.toString("utf8")
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "Файла logs/errors.log нет — внутренних ошибок не было.";
  }
}

/**
 * Пакет диагностики: один текстовый файл для отправки разработчику.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, name: string, role: string}} user кто собрал
 * @param {{requests?: Array<object>, issues?: Array<object>}} [extra]
 *   requests — журнал запросов, issues — находки «доктора данных»
 */
export function buildSupportReport(db, user, { requests = [], issues = [] } = {}) {
  const info = diagnostics(db);
  const now = utcNow();

  let text = "";
  text += section(
    "ПАКЕТ ДИАГНОСТИКИ БИЛЬЯРДНОГО КЛУБА",
    `Собран: ${now}\n` +
      `Собрал: ${user.name} (${user.role})\n` +
      "Пароли, ключи Tuya и токен Telegram в этот файл не попадают.\n" +
      "Файл можно просто открыть блокнотом и прочитать."
  );

  text += section(
    "ПРОГРАММА",
    asLines({
      версия: info.version,
      node: info.node,
      система: info.platform,
      порт: info.port,
      "сервер запущен": info.started_at,
      "работает секунд": info.uptime_seconds,
      pid: info.pid,
      "код новее сервера": info.restart_required ? "ДА — нужен перезапуск" : "нет",
      "код изменён": info.code_changed_at ?? "—",
    })
  );

  text += section(
    "БАЗА ДАННЫХ",
    asLines({
      файл: info.database.path,
      "размер, байт": info.database.size_bytes,
      "журнал WAL, байт": info.database.wal_size_bytes,
      целостность: info.database.integrity,
      "запись в папку": info.database.folder_writable ? "разрешена" : "ЗАПРЕЩЕНА",
      "режим журнала": info.database.journal_mode,
      "внешние ключи": info.database.foreign_keys,
      "папка в облаке": info.database.in_cloud_folder ? "ДА (риск блокировок)" : "нет",
      "версия схемы": info.database.schema_version ?? "—",
      "схема, ожидаемая программой": info.database.schema_version_expected ?? "—",
    })
  );

  if (info.database.schema_history) {
    text += section(
      "ЧТО ПОЯВЛЯЛОСЬ В СХЕМЕ",
      info.database.schema_history.map((line) => `  ${line}`).join("\n")
    );
  }

  text += section(
    "СКОЛЬКО ЗАПИСЕЙ В ТАБЛИЦАХ",
    tableCounts(db)
      .map((t) => `  ${t.name}: ${t.rows}`)
      .join("\n")
  );

  text += section(
    "РЕЗЕРВНЫЕ КОПИИ",
    info.backups
      ? `  папка: ${info.backups.folder}\n` +
        `  храним последних: ${info.backups.keep}\n` +
        (info.backups.files.length
          ? info.backups.files
              .map((f) => `  ${f.name} — ${f.size_bytes} байт, ${f.created_at}`)
              .join("\n")
          : "  копий пока нет")
      : "  нет данных"
  );

  text += section("НАСТРОЙКИ КЛУБА", asLines(safeSettings(db)));

  text += section(
    "СОТРУДНИКИ",
    staffSummary(db)
      .map(
        (u) =>
          `  #${u.id} ${u.login} — ${u.name}, роль ${u.role}, ` +
          `${u.is_active ? "активен" : "отключён"}, создан ${u.created_at}`
      )
      .join("\n")
  );

  if (issues.length) {
    text += section(
      "НАЙДЕННЫЕ НЕСТЫКОВКИ В ДАННЫХ",
      issues
        .map((i) => `  [${i.code}] ${i.title}: ${i.count}\n      ${i.detail}`)
        .join("\n")
    );
  }

  if (requests.length) {
    text += section(
      `ПОСЛЕДНИЕ ЗАПРОСЫ (${requests.length})`,
      requests
        .map(
          (r) =>
            `  ${r.at} ${r.method} ${r.path} → ${r.status} ` +
            `за ${r.ms} мс — ${r.user ?? "—"}`
        )
        .join("\n")
    );
  }

  const journal = listJournal(db, 500);
  text += section(
    `ЖУРНАЛ СОБЫТИЙ (последние ${journal.length})`,
    journal.map((e) => `  ${e.created_at} ${e.event}: ${e.message}`).join("\n")
  );

  text += section("ЖУРНАЛ ОШИБОК (logs/errors.log)", errorLogTail());

  return text;
}

/** Имя файла пакета: с датой, чтобы файлы не путались. */
export function supportReportFileName() {
  return `diagnostika-${utcNow().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
}

/** Путь к базе — нужен в отчёте и в тестах. */
export const DB_PATH_FOR_REPORT = DATABASE_PATH;
