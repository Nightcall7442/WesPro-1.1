// «Доктор данных»: ищет нестыковки, из-за которых отчёты врут, а стол
// выглядит не так, как есть на самом деле.
//
// Откуда они берутся: компьютер выключили розеткой посреди операции,
// база восстановлена из старой копии, кто-то правил данные руками.
// Программа при обычной работе такого не создаёт — но разбираться с
// последствиями всё равно приходится.
//
// Каждая проверка знает, как себя починить (fix), либо честно говорит,
// что решение за человеком: чинить автоматически то, что может стоить
// клубу денег, нельзя.

import { utcNow, withTransaction } from "../db.js";
import { JournalEvent, logEvent } from "./journal.js";

/**
 * @typedef {Object} Check
 * @property {string} code       короткий код для отчёта
 * @property {string} title      что не так, человеческим языком
 * @property {string} hint       чем это грозит
 * @property {boolean} fixable   можно ли починить кнопкой
 * @property {(db) => Array<object>} find    что нашли (строки)
 * @property {(db) => number} [fix]          починить, вернуть число правок
 */

/** @type {Check[]} */
const CHECKS = [
  {
    code: "table-busy-no-session",
    title: "Стол помечен занятым, но сеанса нет",
    hint: "Стол нельзя открыть: программа считает его занятым.",
    fixable: true,
    find: (db) =>
      db
        .prepare(
          `SELECT t.id, t.name FROM tables t
           WHERE t.status = 'busy'
             AND NOT EXISTS (SELECT 1 FROM table_sessions s
                              WHERE s.table_id = t.id AND s.ended_at IS NULL)`
        )
        .all(),
    fix: (db) =>
      db.prepare(
        `UPDATE tables SET status = 'free'
         WHERE status = 'busy'
           AND NOT EXISTS (SELECT 1 FROM table_sessions s
                            WHERE s.table_id = tables.id AND s.ended_at IS NULL)`
      ).run().changes,
  },
  {
    code: "session-open-table-free",
    title: "Сеанс открыт, а стол помечен свободным",
    hint: "На столе сидят гости, а на карте он зелёный.",
    fixable: true,
    find: (db) =>
      db
        .prepare(
          `SELECT s.id AS session_id, t.id, t.name FROM table_sessions s
           JOIN tables t ON t.id = s.table_id
           WHERE s.ended_at IS NULL AND t.status != 'busy'`
        )
        .all(),
    fix: (db) =>
      db.prepare(
        `UPDATE tables SET status = 'busy'
         WHERE status != 'busy'
           AND EXISTS (SELECT 1 FROM table_sessions s
                        WHERE s.table_id = tables.id AND s.ended_at IS NULL)`
      ).run().changes,
  },
  {
    code: "two-open-sessions",
    title: "На одном столе несколько открытых сеансов",
    hint:
      "Закрытие посчитает только один из них — второй останется висеть. " +
      "Какой сеанс настоящий, решает человек: закройте лишний вручную.",
    fixable: false,
    find: (db) =>
      db
        .prepare(
          `SELECT t.name, COUNT(*) AS open_sessions,
                  GROUP_CONCAT(s.id) AS session_ids
           FROM table_sessions s JOIN tables t ON t.id = s.table_id
           WHERE s.ended_at IS NULL
           GROUP BY s.table_id HAVING COUNT(*) > 1`
        )
        .all(),
  },
  {
    code: "closed-without-total",
    title: "Закрытый сеанс без итоговой суммы",
    hint:
      "Такой сеанс не попадёт в выручку. Пересчитать его автоматически " +
      "нельзя — тариф и скидка могли быть другими.",
    fixable: false,
    find: (db) =>
      db
        .prepare(
          `SELECT s.id, t.name AS table_name, s.started_at, s.ended_at
           FROM table_sessions s JOIN tables t ON t.id = s.table_id
           WHERE s.ended_at IS NOT NULL AND s.total_cost_kopecks IS NULL
           ORDER BY s.id DESC LIMIT 50`
        )
        .all(),
  },
  {
    code: "session-no-shift",
    title: "Сеанс кассира закрыт вне кассовой смены",
    hint:
      "Выручка такого сеанса не попадёт ни в одну смену — пересдача кассы " +
      "не сойдётся. Владелец и разработчик закрывают столы без смены на " +
      "законных основаниях, поэтому их сеансы здесь не считаются.",
    fixable: false,
    find: (db) =>
      db
        .prepare(
          `SELECT s.id, t.name AS table_name, s.ended_at, s.total_cost_kopecks,
                  u.login AS closed_by
           FROM table_sessions s
           JOIN tables t ON t.id = s.table_id
           LEFT JOIN users u ON u.id = s.closed_by
           WHERE s.ended_at IS NOT NULL AND s.close_shift_id IS NULL
             AND COALESCE(s.total_cost_kopecks, 0) > 0
             AND COALESCE(u.role, 'cashier') NOT IN ('developer', 'owner')
           ORDER BY s.id DESC LIMIT 50`
        )
        .all(),
  },
  {
    code: "session-account-over-total",
    title: "Со счёта клиента списано больше, чем стоил сеанс",
    hint:
      "Оплата со счёта не может превышать итог сеанса: иначе в отчётах " +
      "наличная выручка уйдёт в минус, а деньги клиента пропадут.",
    fixable: false,
    find: (db) =>
      db
        .prepare(
          `SELECT s.id, t.name AS table_name, s.ended_at,
                  s.account_kopecks, s.total_cost_kopecks
           FROM table_sessions s
           JOIN tables t ON t.id = s.table_id
           WHERE s.ended_at IS NOT NULL
             AND s.account_kopecks > COALESCE(s.total_cost_kopecks, 0)
           ORDER BY s.id DESC LIMIT 50`
        )
        .all(),
  },
  {
    code: "voucher-active-empty",
    title: "Чек считается действующим, но остаток на нём нулевой",
    hint: "Такой чек предлагается кассиру, а играть по нему нечего.",
    fixable: true,
    find: (db) =>
      db
        .prepare(
          `SELECT id, code FROM vouchers
           WHERE status = 'active' AND balance_kopecks <= 0`
        )
        .all(),
    fix: (db) =>
      db.prepare(
        `UPDATE vouchers SET status = 'used', redeemed_at = COALESCE(redeemed_at, ?)
         WHERE status = 'active' AND balance_kopecks <= 0`
      ).run(utcNow()).changes,
  },
  {
    code: "voucher-used-with-balance",
    title: "Чек помечен использованным, но остаток на нём остался",
    hint: "Деньги «висят» в отчёте по чекам, хотя по чеку уже играли.",
    fixable: true,
    find: (db) =>
      db
        .prepare(
          `SELECT id, code, balance_kopecks FROM vouchers
           WHERE status IN ('used', 'cancelled') AND balance_kopecks > 0`
        )
        .all(),
    fix: (db) =>
      db.prepare(
        `UPDATE vouchers SET balance_kopecks = 0
         WHERE status IN ('used', 'cancelled') AND balance_kopecks > 0`
      ).run().changes,
  },
  {
    code: "session-ghost-client",
    title: "Сеанс ссылается на удалённого клиента",
    hint: "В истории и статистике клиента такой сеанс не виден.",
    fixable: true,
    find: (db) =>
      db
        .prepare(
          `SELECT s.id, s.client_id FROM table_sessions s
           WHERE s.client_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = s.client_id)`
        )
        .all(),
    fix: (db) =>
      db.prepare(
        `UPDATE table_sessions SET client_id = NULL
         WHERE client_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = table_sessions.client_id)`
      ).run().changes,
  },
  {
    code: "client-bad-discount",
    title: "У клиента скидка вне разумных границ",
    hint: "Скидка больше 100% или отрицательная ломает расчёт стоимости.",
    fixable: true,
    find: (db) =>
      db
        .prepare(
          `SELECT id, name, discount_percent FROM clients
           WHERE discount_percent < 0 OR discount_percent > 100`
        )
        .all(),
    fix: (db) =>
      db.prepare(
        `UPDATE clients
           SET discount_percent = CASE WHEN discount_percent < 0 THEN 0 ELSE 100 END
         WHERE discount_percent < 0 OR discount_percent > 100`
      ).run().changes,
  },
  {
    code: "duplicate-logins",
    title: "Логины различаются только регистром",
    hint:
      "Вход не учитывает регистр, поэтому под таким логином войдёт не тот " +
      "человек. Один из аккаунтов нужно переименовать вручную.",
    fixable: false,
    find: (db) =>
      db
        .prepare(
          `SELECT LOWER(login) AS login_lc, COUNT(*) AS accounts,
                  GROUP_CONCAT(login) AS logins
           FROM users GROUP BY LOWER(login) HAVING COUNT(*) > 1`
        )
        .all(),
  },
  {
    code: "shift-open-too-long",
    title: "Смена открыта больше суток",
    hint:
      "Скорее всего кассир забыл её закрыть: выручка и часы работы копятся " +
      "в одну смену. Закрыть должен сам кассир — он сдаёт деньги.",
    fixable: false,
    find: (db) =>
      db
        .prepare(
          `SELECT sh.id, u.name AS user_name, sh.opened_at
           FROM shifts sh JOIN users u ON u.id = sh.user_id
           WHERE sh.closed_at IS NULL
             AND CAST(strftime('%s', 'now') AS INTEGER)
                 - CAST(strftime('%s', sh.opened_at) AS INTEGER) > 86400`
        )
        .all(),
  },
];

/** Короткое описание находки для отчёта. */
function describe(rows) {
  return rows
    .slice(0, 10)
    .map((row) =>
      Object.entries(row)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    )
    .join(" | ");
}

/**
 * Осмотр базы: что не так и можно ли это починить кнопкой.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function checkupData(db) {
  const issues = [];
  for (const check of CHECKS) {
    let rows = [];
    try {
      rows = check.find(db);
    } catch (error) {
      // Проверка может опираться на таблицу, которой в старой базе нет.
      issues.push({
        code: check.code,
        title: check.title,
        hint: "Проверку выполнить не удалось",
        detail: error.message,
        count: 0,
        fixable: false,
        failed: true,
      });
      continue;
    }
    if (!rows.length) continue;
    issues.push({
      code: check.code,
      title: check.title,
      hint: check.hint,
      detail: describe(rows),
      count: rows.length,
      fixable: Boolean(check.fixable && check.fix),
    });
  }
  return {
    checked_at: utcNow(),
    checks_total: CHECKS.length,
    issues,
    healthy: issues.length === 0,
  };
}

/**
 * Починка. Без кода — чинит всё, что умеет; с кодом — только эту
 * проверку. То, что помечено «решает человек», не трогается никогда.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, name: string}} user
 * @param {string | null} [code]
 */
export function fixData(db, user, code = null) {
  const targets = CHECKS.filter(
    (c) => c.fixable && c.fix && (!code || c.code === code)
  );
  if (code && !targets.length) {
    return { fixed: [], total: 0, note: "Эта нестыковка чинится только вручную" };
  }

  const fixed = [];
  withTransaction(db, () => {
    for (const check of targets) {
      let changes = 0;
      try {
        changes = check.fix(db);
      } catch (error) {
        fixed.push({ code: check.code, changes: 0, error: error.message });
        continue;
      }
      if (changes > 0) fixed.push({ code: check.code, changes });
    }
    const total = fixed.reduce((sum, f) => sum + (f.changes ?? 0), 0);
    if (total > 0) {
      logEvent(
        db,
        JournalEvent.SETTINGS_UPDATED,
        `Доктор данных исправил записей: ${total} ` +
          `(${fixed.map((f) => `${f.code}: ${f.changes}`).join(", ")}) — ${user.name}`
      );
    }
  });

  return {
    fixed,
    total: fixed.reduce((sum, f) => sum + (f.changes ?? 0), 0),
  };
}
