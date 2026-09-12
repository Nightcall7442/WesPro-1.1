// Перенос настройки клуба на другой компьютер — без истории.
//
// Зачем отдельно от копии базы: копия тащит всё, включая сеансы, смены и
// клиентов. А когда открывают второй клуб или меняют компьютер, нужно
// перенести только «как настроено»: тарифы, расписания, акции, права,
// настройки клуба и расстановку зала. История нового клуба должна
// начаться с чистого листа.
//
// Что НЕ переносится намеренно: сотрудники и пароли (в новом клубе свои
// люди), сеансы, смены, клиенты, чеки, движение денег — это история, а
// не настройка.

import { utcNow, withTransaction } from "../db.js";
import { ConflictError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";
import { getSettings, saveSettings } from "./settings.js";

/** Версия формата: при несовпадении честно скажем, что файл не тот. */
export const CONFIG_FORMAT = 1;

/** Настройки, которые не переносим: они про конкретный компьютер. */
const LOCAL_ONLY = new Set([
  "tuya_access_id",
  "tuya_access_secret",
  "tuya_api_host",
  "lighting_driver",
  "telegram_bot_token",
  "telegram_chat_id",
]);

/**
 * Собирает файл настройки клуба.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function exportConfig(db) {
  const settings = { ...getSettings(db) };
  for (const key of LOCAL_ONLY) delete settings[key];

  return {
    format: CONFIG_FORMAT,
    exported_at: utcNow(),
    club_name: settings.club_name,
    settings,
    tariffs: db
      .prepare("SELECT name, price_per_hour, is_active FROM tariffs ORDER BY id")
      .all(),
    tariff_rules: db
      .prepare(
        `SELECT tr.name AS tariff_name, r.days, r.start_minute, r.end_minute
         FROM tariff_rules r JOIN tariffs tr ON tr.id = r.tariff_id ORDER BY r.id`
      )
      .all(),
    promotions: db
      .prepare(
        `SELECT name, discount_percent, days, start_minute, end_minute, is_active
         FROM promotions ORDER BY id`
      )
      .all(),
    // Тарифы стола выгружаем ПО ИМЕНИ: id в новой базе будут другие, а
    // без этой привязки перенос настройки оставит столы без цены.
    tables: db
      .prepare(
        `SELECT t.id, t.name, t.kind, t.pos_x, t.pos_y, t.size_w, t.size_h
         FROM tables t WHERE t.is_active = 1 ORDER BY t.id`
      )
      .all()
      .map((table) => {
        const { id, ...rest } = table;
        return {
          ...rest,
          tariff_names: db
            .prepare(
              `SELECT tf.name FROM table_tariffs tt
               JOIN tariffs tf ON tf.id = tt.tariff_id
               WHERE tt.table_id = ? ORDER BY tf.id`
            )
            .all(id)
            .map((r) => r.name),
        };
      }),
    plan_elements: db
      .prepare("SELECT type, x, y, w, h FROM plan_elements ORDER BY id")
      .all(),
    role_permissions: db
      .prepare("SELECT role, permission, allowed FROM role_permissions ORDER BY role")
      .all(),
    menu_items: db
      .prepare("SELECT name, price, category, is_active FROM menu_items ORDER BY id")
      .all(),
    // Устройства зала — название и цикл. Реле, как и у столов, не
    // переносится: адреса и ключи привязаны к конкретному помещению.
    devices: db
      .prepare("SELECT name, work_minutes, rest_minutes FROM devices ORDER BY id")
      .all(),
  };
}

/**
 * Латинская запись русского названия: в имени файла и в заголовке ответа
 * кириллице не место (браузеры и заголовки HTTP её ломают).
 */
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function translit(text) {
  return String(text ?? "")
    .toLowerCase()
    .split("")
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join("")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
}

/** Имя файла: с названием клуба и датой, чтобы файлы не путались. */
export function configFileName(clubName) {
  return `nastroyki-${translit(clubName) || "club"}-${utcNow().slice(0, 10)}.json`;
}

/**
 * Загружает настройку из файла.
 *
 * Столы и элементы плана: существующие с теми же названиями не
 * дублируются, новые добавляются. Тарифы, акции и расписания заменяются
 * целиком — иначе после нескольких загрузок в списке была бы каша.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} data содержимое файла
 * @param {{id: number, name: string}} user
 */
export function importConfig(db, data, user) {
  if (!data || typeof data !== "object") {
    throw new ConflictError("Файл настроек пустой или не читается");
  }
  if (Number(data.format) !== CONFIG_FORMAT) {
    throw new ConflictError(
      `Файл настроек другого формата (${data.format ?? "неизвестно"}) — ` +
        `эта программа понимает формат ${CONFIG_FORMAT}`
    );
  }
  if (!data.settings || typeof data.settings !== "object") {
    throw new ConflictError("В файле нет раздела настроек — похоже, это не тот файл");
  }

  const applied = {
    settings: 0,
    tariffs: 0,
    tariff_rules: 0,
    promotions: 0,
    tables: 0,
    plan_elements: 0,
    role_permissions: 0,
    menu_items: 0,
    devices: 0,
  };

  withTransaction(db, () => {
    // Настройки клуба (без «местных» — их в файле и нет).
    const patch = { ...data.settings };
    for (const key of LOCAL_ONLY) delete patch[key];
    saveSettings(db, patch);
    applied.settings = Object.keys(patch).length;

    // Тарифы и всё, что на них ссылается, — заменяем целиком.
    if (Array.isArray(data.tariffs) && data.tariffs.length) {
      db.exec("DELETE FROM tariff_rules");
      db.exec("DELETE FROM table_tariffs");
      // Тарифы, по которым есть сеансы, удалить нельзя — оставляем их,
      // но выключаем: история важнее чистоты списка.
      const used = new Set(
        db
          .prepare("SELECT DISTINCT tariff_id AS id FROM table_sessions")
          .all()
          .map((r) => r.id)
      );
      for (const row of db.prepare("SELECT id FROM tariffs").all()) {
        if (used.has(row.id)) {
          db.prepare("UPDATE tariffs SET is_active = 0 WHERE id = ?").run(row.id);
        } else {
          db.prepare("DELETE FROM tariffs WHERE id = ?").run(row.id);
        }
      }
      const insertTariff = db.prepare(
        `INSERT INTO tariffs (name, price_per_hour, is_active, created_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const tariff of data.tariffs) {
        insertTariff.run(
          String(tariff.name),
          Number(tariff.price_per_hour),
          tariff.is_active ? 1 : 0,
          utcNow()
        );
        applied.tariffs += 1;
      }
    }

    if (Array.isArray(data.tariff_rules)) {
      const insertRule = db.prepare(
        `INSERT INTO tariff_rules (tariff_id, days, start_minute, end_minute, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const rule of data.tariff_rules) {
        const tariff = db
          .prepare("SELECT id FROM tariffs WHERE name = ? ORDER BY id DESC")
          .get(String(rule.tariff_name));
        if (!tariff) continue; // тарифа с таким названием в файле не было
        insertRule.run(
          tariff.id,
          String(rule.days),
          Number(rule.start_minute),
          Number(rule.end_minute),
          utcNow()
        );
        applied.tariff_rules += 1;
      }
    }

    if (Array.isArray(data.promotions)) {
      db.exec("DELETE FROM promotions");
      const insertPromo = db.prepare(
        `INSERT INTO promotions
           (name, discount_percent, days, start_minute, end_minute, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const promo of data.promotions) {
        insertPromo.run(
          String(promo.name),
          Number(promo.discount_percent),
          String(promo.days),
          Number(promo.start_minute),
          Number(promo.end_minute),
          promo.is_active ? 1 : 0,
          utcNow()
        );
        applied.promotions += 1;
      }
    }

    // Столы: одноимённые не дублируем, у них только обновляем место.
    if (Array.isArray(data.tables)) {
      const insertTable = db.prepare(
        `INSERT INTO tables (name, status, kind, pos_x, pos_y, size_w, size_h,
                             is_active, created_at)
         VALUES (?, 'free', ?, ?, ?, ?, ?, 1, ?)`
      );
      for (const table of data.tables) {
        const existing = db
          .prepare("SELECT id FROM tables WHERE name = ?")
          .get(String(table.name));
        if (existing) {
          db.prepare(
            `UPDATE tables SET kind = ?, pos_x = ?, pos_y = ?, size_w = ?, size_h = ?
             WHERE id = ?`
          ).run(
            table.kind ?? "billiard",
            table.pos_x ?? null,
            table.pos_y ?? null,
            table.size_w ?? 4,
            table.size_h ?? 3,
            existing.id
          );
        } else {
          insertTable.run(
            String(table.name),
            table.kind ?? "billiard",
            table.pos_x ?? null,
            table.pos_y ?? null,
            table.size_w ?? 4,
            table.size_h ?? 3,
            utcNow()
          );
        }

        // Возвращаем цену стола: тарифы уже загружены выше, ищем их по
        // имени — id в этой базе свои.
        if (Array.isArray(table.tariff_names) && table.tariff_names.length) {
          const tableId = db
            .prepare("SELECT id FROM tables WHERE name = ?")
            .get(String(table.name)).id;
          const link = db.prepare(
            "INSERT INTO table_tariffs (table_id, tariff_id) VALUES (?, ?)"
          );
          for (const tariffName of table.tariff_names) {
            const tariff = db
              .prepare("SELECT id FROM tariffs WHERE name = ?")
              .get(String(tariffName));
            if (tariff) link.run(tableId, tariff.id);
          }
        }
        applied.tables += 1;
      }
    }

    // Стены и мебель — расстановка целиком.
    if (Array.isArray(data.plan_elements)) {
      db.exec("DELETE FROM plan_elements");
      const insertEl = db.prepare(
        `INSERT INTO plan_elements (type, x, y, w, h, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const el of data.plan_elements) {
        insertEl.run(
          String(el.type),
          Number(el.x),
          Number(el.y),
          Number(el.w),
          Number(el.h),
          utcNow()
        );
        applied.plan_elements += 1;
      }
    }

    if (Array.isArray(data.role_permissions)) {
      const upsert = db.prepare(
        `INSERT INTO role_permissions (role, permission, allowed) VALUES (?, ?, ?)
         ON CONFLICT (role, permission) DO UPDATE SET allowed = excluded.allowed`
      );
      for (const row of data.role_permissions) {
        upsert.run(String(row.role), String(row.permission), row.allowed ? 1 : 0);
        applied.role_permissions += 1;
      }
    }

    if (Array.isArray(data.menu_items)) {
      const insertItem = db.prepare(
        `INSERT INTO menu_items (name, price, category, is_active, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const item of data.menu_items) {
        const existing = db
          .prepare("SELECT id FROM menu_items WHERE name = ?")
          .get(String(item.name));
        if (existing) continue;
        insertItem.run(
          String(item.name),
          Number(item.price),
          String(item.category ?? ""),
          item.is_active ? 1 : 0,
          utcNow()
        );
        applied.menu_items += 1;
      }
    }

    // Устройства зала: одноимённым обновляем цикл, новые добавляем
    // (без реле и выключенными — реле подключат на месте).
    if (Array.isArray(data.devices)) {
      const insertDevice = db.prepare(
        `INSERT INTO devices (name, work_minutes, rest_minutes, created_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const device of data.devices) {
        const name = String(device.name ?? "").trim();
        const work = Number(device.work_minutes);
        const rest = Number(device.rest_minutes);
        if (!name || !Number.isInteger(work) || work < 1 || !Number.isInteger(rest) || rest < 0) {
          continue; // битая строка в файле — не повод ронять весь перенос
        }
        const existing = db.prepare("SELECT id FROM devices WHERE name = ?").get(name);
        if (existing) {
          db.prepare("UPDATE devices SET work_minutes = ?, rest_minutes = ? WHERE id = ?").run(
            work,
            rest,
            existing.id
          );
        } else {
          insertDevice.run(name, work, rest, utcNow());
        }
        applied.devices += 1;
      }
    }

    logEvent(
      db,
      JournalEvent.SETTINGS_UPDATED,
      `Загружена настройка клуба из файла (${data.club_name ?? "без названия"}, ` +
        `${data.exported_at ?? "дата неизвестна"}): тарифов ${applied.tariffs}, ` +
        `акций ${applied.promotions}, столов ${applied.tables} — ${user.name}`
    );
  });

  return applied;
}
