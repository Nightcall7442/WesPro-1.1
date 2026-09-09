// Диагностика: журнал внутренних ошибок сервера и проверка состояния
// базы данных.
//
// Зачем: «Внутренняя ошибка сервера» в браузере не говорит ничего, а
// настоящая причина печаталась только в свёрнутом окне сервера — и
// терялась. Теперь ошибки пишутся в файл, а вкладка «Настройки»
// показывает последние из них и состояние базы. Так причину видно
// сразу, не залезая в консоль.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DATABASE_PATH, PORT, ROOT_DIR } from "../config.js";
import { SCHEMA_HISTORY, SCHEMA_VERSION, schemaVersionOf } from "../db.js";

const LOG_DIR = path.join(ROOT_DIR, "logs");
const LOG_PATH = path.join(LOG_DIR, "errors.log");
// Лог не должен расти бесконечно: при превышении оставляем свежий хвост.
const LOG_MAX_BYTES = 512 * 1024;
const STARTED_AT = new Date().toISOString();

let appVersion = "неизвестна";
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")
  );
  appVersion = pkg.version ?? appVersion;
} catch {
  // package.json не прочитался — версия не критична.
}

// --- «Файлы обновили, а сервер не перезапустили» -------------------------
// Самая коварная ситуация при обновлении программы: файлы распаковали
// поверх старых, браузер уже отдаёт новую страницу, а сервер продолжает
// работать со старым кодом в памяти. Тогда новая страница просит
// маршруты, которых старый сервер не знает (404), и натыкается на баги,
// которые в файлах уже исправлены (500). Ловим это сравнением времени
// файлов кода со временем запуска сервера.

const CODE_DIRS = [path.join(ROOT_DIR, "src"), path.join(ROOT_DIR, "public")];
const STARTED_AT_MS = Date.now();
const STALE_CACHE_MS = 10_000;
let staleCache = { checkedAt: 0, codeChangedAtMs: 0 };

/** Самое свежее изменение файлов кода (mtime и ctime — см. ниже). */
function newestCodeChangeMs() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const st = fs.statSync(full);
        // mtime — когда файл правили; ctime — когда его положили на место
        // (распаковка архива сохраняет старый mtime, но ctime обновляет).
        newest = Math.max(newest, st.mtimeMs, st.ctimeMs);
      } catch {
        // Файл исчез между чтением списка и stat — не важно.
      }
    }
  };
  for (const dir of CODE_DIRS) walk(dir);
  return newest;
}

/**
 * true — на диске лежит код новее, чем тот, с которым запущен сервер.
 * Значит программу обновили, а сервер не перезапустили.
 */
export function isServerStale() {
  const now = Date.now();
  if (now - staleCache.checkedAt > STALE_CACHE_MS) {
    staleCache = { checkedAt: now, codeChangedAtMs: newestCodeChangeMs() };
  }
  // Секунда запаса: файлы могли долистаться в момент старта сервера.
  return staleCache.codeChangedAtMs > STARTED_AT_MS + 1000;
}

/** Короткая строка запроса для лога: «PUT /api/plan». */
function requestLabel(req) {
  if (!req) return "—";
  return `${req.method} ${req.originalUrl ?? req.url ?? ""}`.trim();
}

/**
 * Записывает внутреннюю ошибку в logs/errors.log.
 * Ошибка записи лога намеренно проглатывается: из-за неё нельзя ронять
 * ответ пользователю (а причина как раз может быть в правах на папку).
 * @param {unknown} error
 * @param {import("express").Request} [req]
 */
export function logServerError(error, req) {
  const stamp = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : "";
  const user = req?.user ? `${req.user.login} (${req.user.role})` : "—";
  const entry =
    `[${stamp}] ${requestLabel(req)}\n` +
    `  пользователь: ${user}\n` +
    `  ошибка: ${message}\n` +
    (stack ? `  ${stack.split("\n").slice(1, 4).join("\n  ")}\n` : "") +
    "\n";
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      const tail = fs.readFileSync(LOG_PATH, "utf8").slice(-LOG_MAX_BYTES / 2);
      fs.writeFileSync(LOG_PATH, tail);
    }
    fs.appendFileSync(LOG_PATH, entry);
  } catch {
    // Писать некуда — остаётся вывод в консоль сервера (см. app.js).
  }
  return { stamp, message };
}

/**
 * Последние записи журнала ошибок, свежие сверху.
 * @param {number} [limit]
 */
export function readRecentErrors(limit = 20) {
  let raw = "";
  try {
    raw = fs.readFileSync(LOG_PATH, "utf8");
  } catch {
    return []; // файла нет — ошибок не было
  }
  return raw
    .split(/\n(?=\[\d{4}-)/) // записи начинаются с «[2026-…»
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(-limit)
    .reverse();
}

/** Можно ли писать в папку — частая причина отказов базы на Windows. */
function folderWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * Состояние программы и базы: версия, где лежит база, цела ли она,
 * есть ли права на запись. Плюс последние ошибки.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function diagnostics(db) {
  const dbDir = path.dirname(DATABASE_PATH);
  const info = {
    version: appVersion,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    port: PORT,
    started_at: STARTED_AT,
    uptime_seconds: Math.round(process.uptime()),
    pid: process.pid,
    // Файлы кода новее запущенного сервера — программу обновили, а сервер
    // не перезапустили: главная причина «404 на новый запрос» и «500 на
    // том, что в файлах уже исправлено».
    restart_required: isServerStale(),
    code_changed_at: staleCache.codeChangedAtMs
      ? new Date(staleCache.codeChangedAtMs).toISOString()
      : null,
    database: {
      path: DATABASE_PATH,
      size_bytes: fileSize(DATABASE_PATH),
      wal_size_bytes: fileSize(`${DATABASE_PATH}-wal`),
      folder_writable: folderWritable(dbDir),
      integrity: "не проверялась",
      journal_mode: null,
      foreign_keys: null,
      // Версия схемы: сразу видно, «с какой программы» эта база.
      schema_version: schemaVersionOf(db),
      schema_version_expected: SCHEMA_VERSION,
      schema_history: SCHEMA_HISTORY.map(([v, what]) => `${v}: ${what}`),
      // Папка в облачной синхронизации — частая причина «database is locked».
      in_cloud_folder: /onedrive|dropbox|яндекс|yandex[ _-]?disk|google[ _-]?drive/i.test(
        DATABASE_PATH
      ),
    },
    errors: readRecentErrors(20),
  };

  try {
    // quick_check дешевле integrity_check и ловит те же поломки файла.
    const check = db.prepare("PRAGMA quick_check(1)").get();
    info.database.integrity = Object.values(check ?? {})[0] ?? "нет ответа";
  } catch (error) {
    info.database.integrity = `ошибка проверки: ${error.message}`;
  }
  try {
    info.database.journal_mode = Object.values(
      db.prepare("PRAGMA journal_mode").get() ?? {}
    )[0];
    info.database.foreign_keys = Boolean(
      Object.values(db.prepare("PRAGMA foreign_keys").get() ?? {})[0]
    );
  } catch {
    // Не критично для диагностики.
  }

  return info;
}
