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

export const PORT = Number(process.env.PORT ?? 8000);

// Сидинг стартовых данных при первом запуске на пустой базе.
// В тестах отключается: BILLIARDS_SEED=0.
export const SEED_INITIAL_DATA = process.env.BILLIARDS_SEED !== "0";

export const PUBLIC_DIR = path.join(ROOT_DIR, "public");

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
