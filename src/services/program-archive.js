// Программа одним архивом — перенести на компьютер клуба.
//
// Кнопка «Скачать wespro-club.zip» в «Настройках»: архив собирается на
// лету из папки, откуда запущена программа. Внутри — исходники,
// страницы, батники и уже установленные библиотеки (только те, что нужны
// для работы, без инструментов сборки): распаковали, запустили
// start-club.bat — и программа работает даже без интернета для npm.
//
// Берём только то, что перечислено в списке, — а не «всё, кроме»: так в
// архив не утечёт ни база клуба, ни копии, ни журналы, ни .env с ключами,
// даже если рядом появится что-то новое.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { IS_EXE, ROOT_DIR } from "../config.js";
import { ConflictError } from "./errors.js";

/** Папка внутри архива: распаковали — получили wespro-club\…. */
const ARCHIVE_ROOT = "wespro-club";

/** Что из папки программы входит в архив. */
const INCLUDE = [
  "package.json",
  "package-lock.json",
  "README.md",
  ".env.example",
  "start-club.bat",
  "run-server.bat",
  "firewall-setup.bat",
  "autostart-install.bat",
  "autostart-remove.bat",
  "create-developer.bat",
  "src",
  "public",
  "scripts",
];

/** Все файлы папки (рекурсивно), без вложенных node_modules. */
function walk(dir, skipNodeModules) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipNodeModules && entry.name === "node_modules") continue;
      files.push(...walk(full, skipNodeModules));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Папки библиотек, нужных программе для работы: зависимости из
 * package.json и их зависимости — по тем же правилам поиска, что у Node.
 * Инструменты разработки (devDependencies) не попадают.
 */
function productionModules(root) {
  const found = new Set();
  const visit = (fromDir, name) => {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", name);
      const manifest = path.join(candidate, "package.json");
      if (fs.existsSync(manifest)) {
        if (found.has(candidate)) return;
        found.add(candidate);
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
          visit(candidate, dep);
        }
        return;
      }
      if (dir === root || path.dirname(dir) === dir) return; // не нашлось (необязательная)
    }
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(root, dep);
  return [...found];
}

/** Дата и время в формате ZIP (MS-DOS), по местному времени. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Простейший ZIP: сжатие deflate (или без сжатия, если так меньше), имена
 * в UTF-8. Открывается Проводником Windows и любым архиватором.
 * @param {Array<{name: string, data: Buffer, mtime: Date}>} entries
 */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = zlib.crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // версия для распаковки: 2.0
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/**
 * Собирает wespro-club.zip из папки программы.
 * @param {string} [root] папка программы (в тестах — своя)
 * @returns {Buffer}
 */
export function buildProgramArchive(root = ROOT_DIR) {
  if (IS_EXE && root === ROOT_DIR) {
    throw new ConflictError(
      "В WesPro.exe исходников нет — скачайте архив с компьютера, где программа запущена из папки"
    );
  }
  const files = [];
  for (const item of INCLUDE) {
    const full = path.join(root, item);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) files.push(...walk(full, false));
    else files.push(full);
  }
  for (const dir of productionModules(root)) files.push(...walk(dir, true));
  // Отметка «библиотеки установлены»: по ней start-club.bat понимает, что
  // npm install запускать не нужно.
  const marker = path.join(root, "node_modules", ".package-lock.json");
  if (fs.existsSync(marker)) files.push(marker);

  const entries = files.map((file) => ({
    name: `${ARCHIVE_ROOT}/${path.relative(root, file).split(path.sep).join("/")}`,
    data: fs.readFileSync(file),
    mtime: fs.statSync(file).mtime,
  }));
  if (entries.length > 0xffff) {
    throw new ConflictError("Слишком много файлов для архива — обратитесь к разработчику");
  }
  return zip(entries);
}
