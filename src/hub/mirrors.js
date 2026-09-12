// Снимки баз клубов, которые работают у себя (exe) и присылают копию
// базы в сеть (POST /hub/api/agent/snapshot). По снимку панель показывает
// такой клуб как облачный: столы, выручка, смены, сотрудники, журнал.
//
// Снимок — только для чтения: правки в панели (пароль сотруднику,
// закрыть смену) до самого клуба не дойдут, следующий снимок их
// перекроет. Поэтому для клубов со снимком панель эти кнопки прячет;
// вниз идут только новшества — через ping.
//
// Файл снимка не держится открытым: каждый раз открывается заново и
// закрывается, иначе на Windows новый снимок нельзя было бы положить на
// место старого.

import fs from "node:fs";
import path from "node:path";

import { MIRRORS_DIR } from "../config.js";
import { createDatabase } from "../db.js";
import { ConflictError } from "../services/errors.js";

/** Снимок меньше страницы SQLite — это не база. */
const MIN_BYTES = 4096;

/**
 * @param {{dir?: string}} [options]
 */
export function createMirrors({ dir = MIRRORS_DIR } = {}) {
  const fileOf = (club) => path.join(dir, String(club.id), "billiards.db");

  return {
    /** Есть ли снимок этого клуба. */
    has(club) {
      return fs.existsSync(fileOf(club));
    },

    /** Когда снимок получен (ISO), null — снимка нет. */
    snapshotAt(club) {
      try {
        return fs.statSync(fileOf(club)).mtime.toISOString();
      } catch {
        return null;
      }
    },

    /**
     * Кладёт присланный снимок на место: сначала во временный файл,
     * потом переименование — читающий не увидит половину файла.
     * @param {{id: number}} club
     * @param {Buffer} body
     */
    save(club, body) {
      if (!Buffer.isBuffer(body) || body.length < MIN_BYTES) {
        throw new ConflictError("Снимок пустой или слишком мал для базы");
      }
      if (body.toString("latin1", 0, 15) !== "SQLite format 3") {
        throw new ConflictError("Снимок — не файл базы SQLite");
      }
      const file = fileOf(club);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, body);
      // Снимок мог прийти битым — открываем и спрашиваем, прежде чем
      // положить на место.
      const probe = createDatabase(temp);
      try {
        probe.prepare("SELECT COUNT(*) FROM users").get();
      } catch (error) {
        probe.close();
        fs.rmSync(temp, { force: true });
        throw new ConflictError(`Снимок не читается как база программы: ${error.message}`);
      }
      probe.close();
      for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${temp}${suffix}`, { force: true });
      // На Windows занятый файл переименовать нельзя — пробуем несколько раз:
      // читающий держит его доли секунды.
      let lastError = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          fs.renameSync(temp, file);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const until = Date.now() + 100;
          while (Date.now() < until) { /* короткая пауза */ }
        }
      }
      if (lastError) {
        fs.rmSync(temp, { force: true });
        throw new ConflictError("Снимок не удалось положить на место — попробуйте ещё раз");
      }
      for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
      return { bytes: body.length, saved_at: this.snapshotAt(club) };
    },

    /**
     * Открывает снимок; вызывающий обязан закрыть базу. null — снимка нет.
     * @param {{id: number}} club
     */
    open(club) {
      const file = fileOf(club);
      if (!fs.existsSync(file)) return null;
      return createDatabase(file);
    },

    /** Закрыть снимок, сколько бы раз ни позвали: ответ может и завершиться, и оборваться. */
    closer(db) {
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        try {
          db.close();
        } catch {
          // уже закрыта
        }
      };
    },
  };
}
