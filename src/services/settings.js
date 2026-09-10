// Настройки приложения, редактируемые через интерфейс (вкладка «Настройки»).
// Хранятся в таблице settings (ключ-значение). Значения из переменных
// окружения служат значениями по умолчанию, пока настройка не сохранена в UI.

import {
  LIGHTING_DRIVER,
  TUYA_ACCESS_ID,
  TUYA_ACCESS_SECRET,
  TUYA_API_HOST,
} from "../config.js";
import { ConflictError } from "./errors.js";

const DEFAULTS = {
  lighting_driver: LIGHTING_DRIVER,
  tuya_access_id: TUYA_ACCESS_ID,
  tuya_access_secret: TUYA_ACCESS_SECRET,
  tuya_api_host: TUYA_API_HOST,
  // Настройки клуба (правятся во вкладке «Настройки»).
  club_name: "Бильярдный клуб",
  // Логотип клуба рядом с названием: data-URI картинки (хранится в базе,
  // поэтому попадает в резервную копию). Пусто — логотипа нет.
  club_logo: "",
  // Высота логотипа в шапке, пикселей: логотипы бывают очень разной
  // формы, поэтому масштаб выбирается вручную (на странице входа
  // используется та же величина, увеличенная вдвое).
  club_logo_height: "28",
  currency: "₽", // символ валюты во всём интерфейсе, чеках и отчётах
  rounding_step_kopecks: "1", // 1 = без округления, 100 = до рубля, 1000 = до 10 ₽
  min_session_minutes: "0", // минимальное оплачиваемое время сеанса
  tz_offset_minutes: "180", // локальный пояс клуба (для расписаний и отчётов)
  // За сколько минут до конца оплаченного времени предупреждать кассира
  // (0 — не предупреждать) и подавать ли короткий звуковой сигнал.
  // Напоминания о бронях в Telegram. Пусто — функция выключена.
  telegram_bot_token: "",
  telegram_chat_id: "",
  telegram_before_minutes: "60",
  // Связь с центральной панелью сети WesPro (хабом): статус подписки во
  // вкладке «Настройки». Ключ выдаётся в личном кабинете клуба на сайте
  // (/account) — пока он не введён, проверка просто выключена.
  wespro_hub_url: "https://www.wespro.uz",
  wespro_club_key: "",
  // Ширина чековой ленты: 58 или 80 мм для термопринтера, a4 — обычный
  // принтер (лист A4). От неё зависит вёрстка печатного чека.
  receipt_width: "80",
  // Акция «каждый N-й час в подарок»: 0 — акции нет.
  bonus_every_hours: "0",
  warn_before_minutes: "5",
  warn_sound: "1",
  plan_cols: "40", // сетка плана зала: ширина в клетках
  plan_rows: "25", // сетка плана зала: высота в клетках
};

const ALLOWED_KEYS = Object.keys(DEFAULTS);
const ALLOWED_DRIVERS = ["mock", "tuya"];
const ALLOWED_ROUNDING = ["1", "100", "1000"];
// Логотип: только картинка как data-URI и не больше ~1.5 МБ в base64,
// иначе каждая загрузка страницы тащила бы лишние мегабайты.
const LOGO_PATTERN = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const LOGO_MAX_CHARS = 1_500_000;

function validateIntInRange(key, value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConflictError(`Недопустимое значение «${value}» для ${key}`);
  }
}

/**
 * Текущие настройки: сохранённые в базе поверх значений по умолчанию.
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {typeof DEFAULTS}
 */
export function getSettings(db) {
  const stored = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value])
  );
  const result = { ...DEFAULTS };
  for (const key of ALLOWED_KEYS) {
    if (key in stored) result[key] = stored[key];
  }
  return result;
}

/**
 * Сохраняет присланные поля (только известные ключи).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {Record<string, unknown>} patch
 */
export function saveSettings(db, patch) {
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  );
  for (const key of ALLOWED_KEYS) {
    if (!(key in patch)) continue;
    const value = String(patch[key] ?? "").trim();
    if (key === "lighting_driver" && !ALLOWED_DRIVERS.includes(value)) {
      throw new ConflictError(
        `Недопустимый драйвер освещения «${value}» (mock или tuya)`
      );
    }
    if (key === "rounding_step_kopecks" && !ALLOWED_ROUNDING.includes(value)) {
      throw new ConflictError("Шаг округления: 1 (нет), 100 (до ₽) или 1000 (до 10 ₽)");
    }
    if (key === "min_session_minutes") validateIntInRange(key, value, 0, 240);
    if (key === "warn_before_minutes") validateIntInRange(key, value, 0, 60);
    if (key === "bonus_every_hours") validateIntInRange(key, value, 0, 500);
    if (key === "telegram_before_minutes") validateIntInRange(key, value, 5, 1440);
    if (key === "receipt_width" && !["58", "80", "a4"].includes(value)) {
      throw new ConflictError("Ширина чека: 58, 80 (мм) или a4");
    }
    if (key === "warn_sound" && !["0", "1"].includes(value)) {
      throw new ConflictError("Звук предупреждения: 0 (выкл) или 1 (вкл)");
    }
    if (key === "tz_offset_minutes") validateIntInRange(key, value, -720, 840);
    if (key === "plan_cols") validateIntInRange(key, value, 10, 120);
    if (key === "plan_rows") validateIntInRange(key, value, 8, 80);
    if (key === "club_logo_height") validateIntInRange(key, value, 16, 96);
    if (key === "club_name" && !value) {
      throw new ConflictError("Название клуба не может быть пустым");
    }
    if (key === "club_logo" && value) {
      if (!LOGO_PATTERN.test(value) || value.length > LOGO_MAX_CHARS) {
        throw new ConflictError(
          "Логотип: картинка PNG, JPG, WebP или SVG размером до 1 МБ"
        );
      }
    }
    if (key === "currency" && (!value || value.length > 6)) {
      throw new ConflictError("Валюта: от 1 до 6 символов (например ₽, ₸, сом)");
    }
    upsert.run(key, value);
  }
  return getSettings(db);
}

/**
 * Настройки клуба в числовом виде — для биллинга, расписаний и отчётов.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function getClubSettings(db) {
  const s = getSettings(db);
  return {
    club_name: s.club_name,
    club_logo: s.club_logo,
    club_logo_height: Number(s.club_logo_height),
    currency: s.currency,
    rounding_step_kopecks: Number(s.rounding_step_kopecks),
    min_session_minutes: Number(s.min_session_minutes),
    receipt_width: s.receipt_width,
    warn_before_minutes: Number(s.warn_before_minutes),
    warn_sound: s.warn_sound === "1",
    tz_offset_minutes: Number(s.tz_offset_minutes),
  };
}
