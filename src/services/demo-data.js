// Демонстрационные данные: клуб «как настоящий» одной кнопкой.
//
// Зачем. Показать программу клиенту на пустой базе невозможно: отчёты
// пустые, графики плоские, «Клиенты» и «Смены» ничего не показывают.
// А наполнять руками месяц истории — полдня работы.
//
// Что важно: демо-данные помечены и стираются той же кнопкой, поэтому
// их нельзя перепутать с настоящими. В названиях — приставка «Демо»,
// в журнале — запись о наполнении и об очистке.

import { utcNow, withTransaction } from "../db.js";
import { JournalEvent, logEvent } from "./journal.js";

/** Приставка, по которой демо-данные узнаются и удаляются. */
export const DEMO_PREFIX = "Демо";

const DEMO_CLIENTS = [
  ["Демо · Андрей Иванов", "+7 900 100-10-01", 0],
  ["Демо · Мария Соколова", "+7 900 100-10-02", 5],
  ["Демо · Пётр Кузьмин", "+7 900 100-10-03", 10],
  ["Демо · Ольга Ким", "+7 900 100-10-04", 0],
  ["Демо · Сергей Белов", "+7 900 100-10-05", 15],
];

const DEMO_TABLES = [
  ["Демо стол 1", "billiard"],
  ["Демо стол 2", "billiard"],
  ["Демо стол 3", "billiard"],
  ["Демо PS5", "ps5"],
];

/** Псевдослучайное, но одинаковое от запуска к запуску — отчёты сравнимы. */
function makeRandom(seed = 20260906) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

/** Сколько сеансов приходится на этот час: вечер загруженнее утра. */
function busyness(hour) {
  if (hour < 12) return 0.15;
  if (hour < 17) return 0.45;
  if (hour < 22) return 1;
  return 0.6;
}

/**
 * Наполняет базу демо-данными: столы, клиенты, история сеансов за
 * последние N дней с разной загрузкой по часам, смены и чеки.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{id: number, name: string}} user от чьего имени «работал» клуб
 * @param {{days?: number}} [options]
 */
export function fillDemoData(db, user, { days = 30 } = {}) {
  const random = makeRandom();
  const created = { tables: 0, clients: 0, sessions: 0, shifts: 0 };

  withTransaction(db, () => {
    // Тариф для демо-сеансов: свой, чтобы не путать с рабочими.
    let tariff = db
      .prepare("SELECT id, price_per_hour FROM tariffs WHERE name = ?")
      .get(`${DEMO_PREFIX} · тариф 500`);
    if (!tariff) {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO tariffs (name, price_per_hour, is_active, created_at)
           VALUES (?, 500, 1, ?)`
        )
        .run(`${DEMO_PREFIX} · тариф 500`, utcNow());
      tariff = { id: Number(lastInsertRowid), price_per_hour: 500 };
    }

    const tableIds = [];
    for (const [name, kind] of DEMO_TABLES) {
      const existing = db.prepare("SELECT id FROM tables WHERE name = ?").get(name);
      if (existing) {
        tableIds.push(existing.id);
        continue;
      }
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO tables (name, status, kind, is_active, created_at)
           VALUES (?, 'free', ?, 1, ?)`
        )
        .run(name, kind, utcNow());
      tableIds.push(Number(lastInsertRowid));
      created.tables += 1;
    }

    const clientIds = [];
    for (const [name, phone, discount] of DEMO_CLIENTS) {
      const existing = db.prepare("SELECT id FROM clients WHERE name = ?").get(name);
      if (existing) {
        clientIds.push(existing.id);
        continue;
      }
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO clients (name, phone, discount_percent, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(name, phone, discount, utcNow());
      clientIds.push(Number(lastInsertRowid));
      created.clients += 1;
    }

    const methods = ["cash", "cash", "cash", "card", "card", "transfer"];
    const now = Date.now();

    for (let day = days; day >= 1; day -= 1) {
      // Одна смена на день: открылась в 12:00, закрылась в 02:00.
      const dayStart = now - day * 24 * 3600 * 1000;
      const openedAt = new Date(dayStart).setHours(12, 0, 0, 0);
      const closedAt = openedAt + 14 * 3600 * 1000;
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO shifts (user_id, opened_at, closed_at,
                               opening_cash_kopecks, closing_cash_kopecks)
           VALUES (?, ?, ?, 500000, 500000)`
        )
        .run(user.id, new Date(openedAt).toISOString(), new Date(closedAt).toISOString());
      const shiftId = Number(lastInsertRowid);
      created.shifts += 1;

      for (let hour = 12; hour <= 23; hour += 1) {
        for (const tableId of tableIds) {
          if (random() > busyness(hour) * 0.5) continue;
          const startedAt = new Date(dayStart).setHours(hour, Math.floor(random() * 50), 0, 0);
          const minutes = 30 + Math.floor(random() * 150); // 30 мин … 3 ч
          const endedAt = startedAt + minutes * 60 * 1000;
          if (endedAt > now) continue;

          const clientId =
            random() < 0.55 ? clientIds[Math.floor(random() * clientIds.length)] : null;
          const discount = clientId
            ? db.prepare("SELECT discount_percent FROM clients WHERE id = ?").get(clientId)
                .discount_percent
            : 0;
          const timeCost = Math.round(
            ((tariff.price_per_hour * 100 * minutes) / 60) * ((100 - discount) / 100)
          );
          const method = methods[Math.floor(random() * methods.length)];

          db.prepare(
            `INSERT INTO table_sessions
               (table_id, tariff_id, price_per_hour_snapshot, started_at, ended_at,
                total_cost_kopecks, time_cost_kopecks, bar_cost_kopecks,
                payment_method, client_id, discount_percent,
                opened_by, closed_by, shift_id, close_shift_id, is_free)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0)`
          ).run(
            tableId,
            tariff.id,
            tariff.price_per_hour,
            new Date(startedAt).toISOString(),
            new Date(endedAt).toISOString(),
            timeCost,
            timeCost,
            method,
            clientId,
            discount,
            user.id,
            user.id,
            shiftId,
            shiftId
          );
          created.sessions += 1;
        }
      }
    }

    logEvent(
      db,
      JournalEvent.SETTINGS_UPDATED,
      `Добавлены демо-данные за ${days} дн.: столов ${created.tables}, ` +
        `клиентов ${created.clients}, сеансов ${created.sessions}, ` +
        `смен ${created.shifts} — ${user.name}`
    );
  });

  return { ...created, days };
}

/**
 * Стирает демо-данные и ничего кроме них: узнаём по приставке «Демо»
 * в названии стола, клиента и тарифа.
 */
export function clearDemoData(db, user) {
  const removed = { sessions: 0, shifts: 0, tables: 0, clients: 0, tariffs: 0 };
  const like = `${DEMO_PREFIX}%`;

  withTransaction(db, () => {
    const tableIds = db
      .prepare("SELECT id FROM tables WHERE name LIKE ?")
      .all(like)
      .map((r) => r.id);
    const tariffIds = db
      .prepare("SELECT id FROM tariffs WHERE name LIKE ?")
      .all(like)
      .map((r) => r.id);
    const clientIds = db
      .prepare("SELECT id FROM clients WHERE name LIKE ?")
      .all(like)
      .map((r) => r.id);

    // Смены, в которых были только демо-сеансы.
    const shiftIds = db
      .prepare(
        `SELECT DISTINCT close_shift_id AS id FROM table_sessions
         WHERE close_shift_id IS NOT NULL
           AND (table_id IN (${tableIds.map(() => "?").join(",") || "NULL"})
                OR tariff_id IN (${tariffIds.map(() => "?").join(",") || "NULL"}))`
      )
      .all(...tableIds, ...tariffIds)
      .map((r) => r.id);

    const inList = (ids) => ids.map(() => "?").join(",") || "NULL";

    removed.sessions = db
      .prepare(
        `DELETE FROM table_sessions
         WHERE table_id IN (${inList(tableIds)})
            OR tariff_id IN (${inList(tariffIds)})`
      )
      .run(...tableIds, ...tariffIds).changes;

    // Смену удаляем только если в ней больше не осталось сеансов.
    for (const shiftId of shiftIds) {
      const left = db
        .prepare(
          "SELECT COUNT(*) AS n FROM table_sessions WHERE close_shift_id = ? OR shift_id = ?"
        )
        .get(shiftId, shiftId).n;
      if (left === 0) {
        removed.shifts += db
          .prepare("DELETE FROM shifts WHERE id = ? AND closed_at IS NOT NULL")
          .run(shiftId).changes;
      }
    }

    removed.tables = db.prepare("DELETE FROM tables WHERE name LIKE ?").run(like).changes;
    removed.clients = db.prepare("DELETE FROM clients WHERE name LIKE ?").run(like).changes;
    removed.tariffs = db.prepare("DELETE FROM tariffs WHERE name LIKE ?").run(like).changes;

    logEvent(
      db,
      JournalEvent.SETTINGS_UPDATED,
      `Стёрты демо-данные: сеансов ${removed.sessions}, смен ${removed.shifts}, ` +
        `столов ${removed.tables}, клиентов ${removed.clients} — ${user.name}`
    );
  });

  return removed;
}

/** Есть ли в базе демо-данные — для честной подписи в интерфейсе. */
export function demoDataPresent(db) {
  const like = `${DEMO_PREFIX}%`;
  const tables = db.prepare("SELECT COUNT(*) AS n FROM tables WHERE name LIKE ?").get(like).n;
  const clients = db.prepare("SELECT COUNT(*) AS n FROM clients WHERE name LIKE ?").get(like).n;
  return { present: tables + clients > 0, tables, clients };
}
