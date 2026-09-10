// Конфигурация приложения. Значения можно переопределить переменными
// окружения, чтобы менять поведение без правки кода.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
  return process.env.WESPRO_NETWORK === "1";
}

export const PORT = Number(process.env.PORT ?? 8000);

// Сидинг стартовых данных при первом запуске на пустой базе.
// В тестах отключается: BILLIARDS_SEED=0.
export const SEED_INITIAL_DATA = process.env.BILLIARDS_SEED !== "0";

export const PUBLIC_DIR = path.join(ROOT_DIR, "public");

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
