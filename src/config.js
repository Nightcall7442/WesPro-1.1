// Конфигурация приложения. Значения можно переопределить переменными
// окружения, чтобы менять поведение без правки кода.

import fs from "node:fs";
import path from "node:path";
import sea from "node:sea";
import { fileURLToPath } from "node:url";

// Программа может быть собрана в один файл WesPro.exe (npm run build:exe):
// тогда её «папка» — папка, где лежит exe, а страницы интерфейса зашиты
// внутрь и распаковываются рядом при запуске.
export const IS_EXE = sea.isSea();

export const ROOT_DIR = IS_EXE
  ? path.dirname(process.execPath)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Версия программы: из package.json, а в exe — зашитая при сборке. */
function readVersion() {
  // eslint-disable-next-line no-undef -- подставляется сборкой exe
  if (typeof __WESPRO_VERSION__ !== "undefined") return __WESPRO_VERSION__;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")).version;
  } catch {
    return "неизвестна";
  }
}
export const APP_VERSION = readVersion();

/**
 * В exe страницы интерфейса зашиты как ресурсы; Express раздаёт их с
 * диска, поэтому при запуске они распаковываются в папку public рядом с
 * exe (перезаписываются каждый раз — так обновление exe обновляет и их).
 */
function unpackPublicAssets() {
  const target = path.join(ROOT_DIR, "public");
  const manifest = JSON.parse(Buffer.from(sea.getAsset("public-manifest.json")).toString("utf8"));
  for (const name of manifest) {
    const file = path.join(target, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(sea.getAsset(`public/${name}`)));
  }
  return target;
}

export const DATABASE_PATH =
  process.env.BILLIARDS_DATABASE_PATH ?? path.join(ROOT_DIR, "billiards.db");

// База центральной панели (сеть клубов): подписки, оплаты, журнал сети.
// Отдельный файл от базы клуба — см. src/hub/db.js.
export const HUB_DATABASE_PATH =
  process.env.WESPRO_HUB_DATABASE_PATH ?? path.join(ROOT_DIR, "hub.db");

// Папка с базами клубов сети: у каждого клуба свой файл
// data/clubs/<id>/billiards.db. Разделение по файлам, а не по колонке
// club_id в общих таблицах: к чужой базе просто нет открытого
// подключения, поэтому забытое условие в запросе не может показать
// одному клубу данные другого.
export const CLUBS_DIR =
  process.env.WESPRO_CLUBS_DIR ?? path.join(ROOT_DIR, "data", "clubs");

// Режим «сеть клубов»: один сервер обслуживает много клубов сразу
// (wespro.uz). Выключен — обычная установка на один клуб, где база одна
// и никакого разделения не нужно.
// Читается при каждом обращении — как landingAtRoot(), чтобы значение
// можно было подменить в тестах.
export function networkMode() {
  // Значение из панели хостинга легко приходит с пробелом или как
  // «true» — считать такую переменную выключенной значило бы молча
  // работать не в том режиме, в каком её просили включить.
  const value = String(process.env.WESPRO_NETWORK ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

export const PORT = Number(process.env.PORT ?? 8000);

// Сидинг стартовых данных при первом запуске на пустой базе.
// В тестах отключается: BILLIARDS_SEED=0.
export const SEED_INITIAL_DATA = process.env.BILLIARDS_SEED !== "0";

export const PUBLIC_DIR = IS_EXE ? unpackPublicAssets() : path.join(ROOT_DIR, "public");

// Снимки баз клубов, которые работают у себя (exe) и присылают копию
// базы в сеть: по ним панель показывает такой клуб так же, как облачный.
export const MIRRORS_DIR =
  process.env.WESPRO_MIRRORS_DIR ?? path.join(ROOT_DIR, "data", "mirrors");

// Что показывать на корневом адресе неавторизованному гостю: описание
// системы (по умолчанию) или сразу форму входа.
//
// По умолчанию — описание: чаще всего на корень заходит тот, кто ещё не
// знает, что это за программа. Сотрудник клуба нажмёт «Войти», а войдя
// один раз, попадает сразу на рабочий стол — сессия живёт месяц.
//
// Клубу, который поставил программу себе и не хочет видеть витрину на
// рабочем месте, достаточно поставить WESPRO_LANDING_ROOT=0.
// Читается при каждом обращении, а не один раз при загрузке модуля: так
// настройку можно поменять переменной окружения (и подменить в тестах),
// не пересобирая модули — тот же приём, что и у папки резервных копий.
export function landingAtRoot() {
  return process.env.WESPRO_LANDING_ROOT !== "0";
}

// --- Освещение -------------------------------------------------------------
// Драйвер, ключи Tuya и привязка столов к реле настраиваются во вкладке
// «Настройки» интерфейса и хранятся в базе. Переменные окружения ниже —
// лишь значения по умолчанию, пока настройки не сохранены через UI.

export const LIGHTING_DRIVER = process.env.BILLIARDS_LIGHTING ?? "mock";
export const TUYA_ACCESS_ID = process.env.TUYA_ACCESS_ID ?? "";
export const TUYA_ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET ?? "";
// Дата-центр аккаунта Smart Life; Россия/Европа — https://openapi.tuyaeu.com
export const TUYA_API_HOST =
  process.env.TUYA_API_HOST ?? "https://openapi.tuyaeu.com";

// Код выхода «перезапустите меня»: его ловит run-server.bat и поднимает
// программу заново. Любой другой код — обычное завершение.
export const RESTART_EXIT_CODE = 7;
