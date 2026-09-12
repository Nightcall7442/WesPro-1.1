// WesPro.exe для клубов: владелец сети собирает его у себя на Windows
// (npm run build:exe) и загружает в панель, клубы скачивают из своих
// «Настроек». Файл лежит на диске сервера рядом с описанием (версия,
// размер, когда и кто загрузил).

import fs from "node:fs";
import path from "node:path";

import { downloadsDir } from "../config.js";
import { ConflictError } from "./errors.js";

export const EXE_NAME = "WesPro.exe";
const INFO_NAME = "WesPro.json";
/** Меньше — точно не exe с Node внутри (он около 90 МБ). */
const MIN_BYTES = 20 * 1024 * 1024;

export function exePath() {
  return path.join(downloadsDir(), EXE_NAME);
}

/** Что лежит на раздаче: null — ещё ничего не загружали. */
export function exeInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(downloadsDir(), INFO_NAME), "utf8"));
    const size = fs.statSync(exePath()).size;
    return { ...info, size };
  } catch {
    return null;
  }
}

/**
 * Кладёт загруженный exe на раздачу.
 * @param {Buffer} body
 * @param {{version: string, by: string}} meta
 */
export function saveExe(body, { version, by }) {
  if (!Buffer.isBuffer(body) || body.length < MIN_BYTES) {
    throw new ConflictError("Это не похоже на WesPro.exe: файл слишком мал");
  }
  // Windows-exe начинается с «MZ».
  if (body[0] !== 0x4d || body[1] !== 0x5a) {
    throw new ConflictError("Это не exe-файл Windows");
  }
  fs.mkdirSync(downloadsDir(), { recursive: true });
  const temp = `${exePath()}.tmp`;
  fs.writeFileSync(temp, body);
  fs.renameSync(temp, exePath());
  const info = {
    version: String(version ?? "").trim() || "неизвестна",
    uploaded_at: new Date().toISOString(),
    by,
  };
  fs.writeFileSync(path.join(downloadsDir(), INFO_NAME), JSON.stringify(info));
  return exeInfo();
}
