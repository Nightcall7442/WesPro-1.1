// Напоминания о бронях через Telegram-бота.
//
// Кому приходит. Сообщение уходит в чат клуба (администратору или в
// рабочую группу), а не гостю: гость с ботом не переписывался, и его
// телефон Telegram’у ничего не говорит. Дежурный получает напоминание
// «через час бронь — Стол 3, Иван, +7…» и звонит гостю сам.
//
// Пока токен и чат не заданы — функция просто выключена: ничего не
// отправляется и никаких ошибок не сыплется.

import { utcNow } from "../db.js";
import { ConflictError } from "./errors.js";
import { logServerError } from "./diagnostics.js";
import { getSettings } from "./settings.js";

const API = "https://api.telegram.org";
/** Сколько ждём ответ Telegram: интернет в клубе бывает медленный. */
const TIMEOUT_MS = 10000;

/** Настройки бота или null, если напоминания не настроены. */
export function telegramConfig(db) {
  const s = getSettings(db);
  const token = (s.telegram_bot_token ?? "").trim();
  const chatId = (s.telegram_chat_id ?? "").trim();
  if (!token || !chatId) return null;
  return {
    token,
    chatId,
    beforeMinutes: Number(s.telegram_before_minutes ?? 60),
  };
}

/**
 * Отправляет сообщение в чат клуба.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} text
 * @returns {Promise<boolean>} отправлено ли
 */
export async function sendTelegramMessage(db, text) {
  const config = telegramConfig(db);
  if (!config) return false;
  const response = await fetch(`${API}/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      disable_notification: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    // Текст ошибки Telegram понятный («chat not found», «Unauthorized») —
    // показываем его как есть, чтобы было ясно, что поправить.
    throw new ConflictError(
      `Telegram не принял сообщение: ${data?.description ?? response.status}`
    );
  }
  return true;
}

/** Проверочное сообщение из настроек — «дошло или нет». */
export async function sendTelegramTest(db, user) {
  if (!telegramConfig(db)) {
    throw new ConflictError(
      "Сначала укажите токен бота и номер чата — без них отправлять некуда"
    );
  }
  await sendTelegramMessage(
    db,
    `Проверка связи: напоминания о бронях работают. Настроил ${user.name}.`
  );
  return { ok: true };
}

/** Дата и время брони в поясе клуба — в сообщении нужно местное время. */
function localTime(iso, tzOffsetMinutes) {
  const local = new Date(Date.parse(iso) + tzOffsetMinutes * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/**
 * Рассылает напоминания о бронях, которые начнутся в ближайшие
 * N минут. Про каждую бронь напоминаем один раз — отметка reminded_at.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {Promise<{sent: number}>}
 */
export async function remindUpcomingBookings(db) {
  const config = telegramConfig(db);
  if (!config) return { sent: 0 };

  const now = utcNow();
  const until = new Date(
    Date.parse(now) + config.beforeMinutes * 60000
  ).toISOString();
  const due = db
    .prepare(
      `SELECT b.id, b.client_name, b.phone, b.starts_at, b.duration_minutes,
              b.note, t.name AS table_name
       FROM bookings b JOIN tables t ON t.id = b.table_id
       WHERE b.status = 'active' AND b.reminded_at IS NULL
         AND b.starts_at > ? AND b.starts_at <= ?
       ORDER BY b.starts_at`
    )
    .all(now, until);

  const tz = Number(getSettings(db).tz_offset_minutes ?? 180);
  let sent = 0;
  for (const booking of due) {
    const minutesLeft = Math.max(
      0,
      Math.round((Date.parse(booking.starts_at) - Date.parse(now)) / 60000)
    );
    const text =
      `Через ${minutesLeft} мин бронь: ${booking.table_name}\n` +
      `${localTime(booking.starts_at, tz)} — ${booking.duration_minutes} мин\n` +
      `Гость: ${booking.client_name}` +
      (booking.phone ? `, ${booking.phone}` : "") +
      (booking.note ? `\nЗаметка: ${booking.note}` : "");
    try {
      await sendTelegramMessage(db, text);
      db.prepare("UPDATE bookings SET reminded_at = ? WHERE id = ?").run(
        utcNow(),
        booking.id
      );
      sent += 1;
    } catch (error) {
      // Не дошло — не отмечаем: попробуем на следующем круге.
      logServerError(
        new Error(`Напоминание о брони №${booking.id} не отправлено: ${error.message}`)
      );
    }
  }
  return { sent };
}

let timer = null;
/** Как часто проверяем брони: раз в минуту — напоминание не опоздает. */
const CHECK_EVERY_MS = 60 * 1000;

/**
 * Включает рассылку напоминаний. Ошибки не должны ронять программу:
 * интернет в клубе может пропасть в любой момент.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function startBookingReminders(db) {
  const run = () => {
    remindUpcomingBookings(db).catch((error) => {
      logServerError(new Error(`Напоминания о бронях: ${error.message}`));
    });
  };
  timer = setInterval(run, CHECK_EVERY_MS);
  timer.unref?.();
  return timer;
}

export function stopBookingReminders() {
  if (timer) clearInterval(timer);
  timer = null;
}
