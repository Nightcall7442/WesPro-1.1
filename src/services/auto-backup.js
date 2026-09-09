// Автоматическая резервная копия базы.
//
// Самая дешёвая страховка от «полетел компьютер»: раз в сутки программа
// сама кладёт копию базы в папку backups рядом с программой и удаляет
// самые старые, чтобы копии не забили диск. Ручной «Экспорт базы»
// никуда не делся — это просто то же самое, но без участия человека.
//
// Копия делается тем же VACUUM INTO, что и ручная: получается один
// компактный файл SQLite, который можно унести на флешке и загрузить
// обратно через «Загрузка базы из копии».

import fs from "node:fs";
import path from "node:path";

import { ROOT_DIR } from "../config.js";
import { utcNow } from "../db.js";
import { logServerError } from "./diagnostics.js";

/**
 * Папка с копиями — рядом с программой, чтобы её было легко найти.
 * Читается при каждом обращении: так её можно переопределить переменной
 * окружения (и подменить в тестах), не пересобирая модуль.
 */
export function backupDir() {
  return process.env.BILLIARDS_BACKUP_DIR ?? path.join(ROOT_DIR, "backups");
}

/** Сколько копий храним: две недели ежедневных — разумный запас. */
export function keepBackups() {
  const n = Number(process.env.BILLIARDS_BACKUP_KEEP ?? 14);
  return Number.isInteger(n) && n > 0 ? n : 14;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_PATTERN = /^billiards-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.db$/;

/** Имя файла копии за сегодня (по местному времени компьютера). */
function fileNameFor(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `billiards-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.db`;
}

/** Список копий, новые сверху. */
export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => FILE_PATTERN.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return {
        name,
        size_bytes: stat.size,
        created_at: new Date(stat.mtimeMs).toISOString(),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Удаляет самые старые копии сверх KEEP_BACKUPS. */
function dropOldBackups() {
  const extra = listBackups().slice(keepBackups());
  for (const backup of extra) {
    try {
      fs.unlinkSync(path.join(backupDir(), backup.name));
    } catch {
      // Файл занят антивирусом или уже удалён — не повод падать.
    }
  }
  return extra.map((b) => b.name);
}

/**
 * Делает копию прямо сейчас. Если копия за сегодня уже есть — перезапишет
 * её (за день копия одна, зато всегда свежая).
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function makeBackupNow(db) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileNameFor());
  // VACUUM INTO отказывается писать поверх существующего файла, поэтому
  // сначала пишем во временный, затем подменяем — так копия за день
  // всегда целая, даже если программу закрыли в середине записи.
  const temp = `${target}.tmp`;
  if (fs.existsSync(temp)) fs.unlinkSync(temp);
  db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
  fs.renameSync(temp, target);
  const removed = dropOldBackups();
  return {
    file: target,
    name: path.basename(target),
    size_bytes: fs.statSync(target).size,
    created_at: utcNow(),
    removed,
  };
}

/** Есть ли уже копия за сегодня. */
function hasTodayBackup() {
  return fs.existsSync(path.join(backupDir(), fileNameFor()));
}

let timer = null;

/**
 * Включает ежедневное копирование: копию делаем при старте (если за
 * сегодня ещё нет) и дальше раз в сутки. Ошибка копирования не должна
 * ронять программу — она уходит в диагностику.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function startAutoBackup(db) {
  const run = () => {
    try {
      if (!hasTodayBackup()) makeBackupNow(db);
    } catch (error) {
      // Причина обычно в правах на папку — записываем её в logs/errors.log,
      // чтобы было видно в «Диагностике».
      logServerError(
        new Error(`Не удалось сделать резервную копию: ${error.message}`)
      );
    }
  };
  run();
  timer = setInterval(run, DAY_MS);
  // Таймер не должен мешать программе закрыться.
  timer.unref?.();
  return timer;
}

/** Останавливает ежедневное копирование (нужно в тестах). */
export function stopAutoBackup() {
  if (timer) clearInterval(timer);
  timer = null;
}
