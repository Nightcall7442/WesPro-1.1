// Связь программы клуба с центральной панелью сети WesPro (хабом):
// «Настройки» → «Подписка» показывает, оплачен ли клуб, до какого числа
// и какой тариф — прямо в самой программе, без захода на отдельный сайт.
//
// Программа клуба и хаб — разные штуки, часто на разных серверах: клуб
// стоит у себя на компьютере, хаб — центральный сайт wespro.uz. Поэтому
// здесь просто HTTP-запрос по ключу клуба (см. src/hub/routes.js →
// POST /hub/api/agent/ping), как и договаривались в README. Пока ключ
// не введён — функция просто выключена, как Telegram-напоминания.

import { APP_VERSION } from "../config.js";
import { ConflictError } from "./errors.js";
import { enabledFeatures, getSettings, setFeatures } from "./settings.js";

/** Сколько ждём ответ хаба: интернет в клубе бывает медленный или его нет вовсе. */
const TIMEOUT_MS = 10000;

const appVersion = APP_VERSION;

/** Настройки связи с хабом или null, если ключ ещё не введён. */
export function hubConfig(db) {
  const s = getSettings(db);
  const key = (s.wespro_club_key ?? "").trim();
  if (!key) return null;
  const url = (s.wespro_hub_url ?? "").trim().replace(/\/+$/, "");
  return { url, key };
}

/** Сколько столов сейчас у клуба — хабу это интересно для лимита тарифа. */
function activeTablesCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM tables WHERE is_active = 1").get().n;
}

/**
 * Отмечается на связи и получает статус подписки. Сетевые проблемы не
 * бросаем как ошибку сервера — это ожидаемая ситуация (клуб мог работать
 * офлайн), поэтому возвращаем понятный статус «не удалось связаться».
 * @param {import("node:sqlite").DatabaseSync} db
 */
export async function checkSubscription(db) {
  const config = hubConfig(db);
  if (!config) {
    return { configured: false };
  }
  try {
    const response = await fetch(`${config.url}/hub/api/agent/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Club-Key": config.key },
      body: JSON.stringify({ version: appVersion, tables: activeTablesCount(db) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401) {
      return {
        configured: true,
        connected: false,
        error: "Ключ клуба не подошёл — проверьте, что скопировали его целиком",
      };
    }
    if (!response.ok) {
      return { configured: true, connected: false, error: `Хаб ответил ошибкой ${response.status}` };
    }
    const data = await response.json();
    // Панель сети решает, какие новшества клубу включены (обновления по
    // клубам): применяем то, что прислали, — так «версия» офлайн-клуба
    // тоже ставится из панели.
    if (data.features && typeof data.features === "object") {
      // Пишем только если что-то отличается: лишняя запись — лишний
      // снимок базы в сеть.
      const current = enabledFeatures(db);
      const patch = Object.fromEntries(
        Object.entries(data.features).filter(([key, value]) => key in current && current[key] !== Boolean(value))
      );
      if (Object.keys(patch).length) setFeatures(db, patch);
    }
    return { configured: true, connected: true, checked_at: new Date().toISOString(), ...data };
  } catch (error) {
    // Нет интернета, хаб недоступен, неверный адрес — для клуба это не
    // авария: программа и без хаба продолжает считать деньги и открывать
    // столы, поэтому не бросаем, а показываем причину как есть.
    return {
      configured: true,
      connected: false,
      error: error.name === "TimeoutError" ? "Хаб не ответил вовремя" : "Не удалось связаться с хабом",
    };
  }
}

/** Проверка по кнопке «Проверить подписку» — требует, чтобы ключ уже был введён. */
export async function checkSubscriptionNow(db) {
  if (!hubConfig(db)) {
    throw new ConflictError("Сначала укажите ключ клуба — его выдают в личном кабинете на сайте WesPro");
  }
  return checkSubscription(db);
}
