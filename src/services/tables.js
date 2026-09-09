// Операции со столами.

import { utcNow, withTransaction } from "../db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";

const TABLE_FIELDS =
  "id, name, status, created_at, tuya_device_id, tuya_switch_code, " +
  "light_kind, light_host, light_channel, light_on_url, light_off_url, " +
  "pos_x, pos_y, size_w, size_h, kind, is_active";

// Тип точки: у всех общие тарифы, сеансы и биллинг — отличается только
// подпись/иконка на плитке. billiard — бильярдный стол (по умолчанию).
export const TABLE_KINDS = new Set(["billiard", "ps3", "ps4", "ps5", "tv"]);

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{includeInactive?: boolean}} [options] includeInactive — показать и удалённые (архивные)
 */
export function listTables(db, { includeInactive = false } = {}) {
  return db
    .prepare(
      `SELECT ${TABLE_FIELDS} FROM tables
       ${includeInactive ? "" : "WHERE is_active = 1"} ORDER BY id`
    )
    .all();
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 */
export function getTable(db, tableId) {
  const table = db
    .prepare(`SELECT ${TABLE_FIELDS} FROM tables WHERE id = ?`)
    .get(tableId);
  if (!table) {
    throw new NotFoundError(`Стол id=${tableId} не найден`);
  }
  return table;
}

/**
 * Позиция и размер стола на плане зала (в клетках сетки).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {{x: number, y: number, w: number, h: number}} layout
 */
export function setTableLayout(db, tableId, layout) {
  const table = getTable(db, tableId);
  const { x, y, w, h } = layout;
  for (const value of [x, y, w, h]) {
    if (!Number.isInteger(value)) {
      throw new ConflictError("Координаты стола должны быть целыми числами");
    }
  }
  if (x < 0 || y < 0 || x > 500 || y > 500) {
    throw new ConflictError("Позиция стола вне допустимых пределов");
  }
  if (w < 2 || h < 1 || w > 16 || h > 12) {
    throw new ConflictError("Размер стола: от 2×1 до 16×12 клеток");
  }
  db.prepare(
    "UPDATE tables SET pos_x = ?, pos_y = ?, size_w = ?, size_h = ? WHERE id = ?"
  ).run(x, y, w, h, table.id);
  return getTable(db, table.id);
}

/**
 * Привязывает стол к реле Tuya/MOES (или отвязывает, если deviceId пуст).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {string | null} deviceId
 * @param {string | null} switchCode канал реле (switch_1 … switch_4)
 */
/** Чем может управляться свет над столом. */
export const LIGHT_KINDS = new Set(["tuya", "tasmota", "shelly", "url"]);

/**
 * Привязка стола к реле.
 *
 * tuya — облако Tuya/MOES: нужны id устройства и канал (switch_1 …);
 * tasmota и shelly — реле в локальной сети: адрес (IP) и номер канала;
 * url — «своё устройство»: два адреса, включить и выключить.
 *
 * Пустой kind (или пустые поля) означает «свет к столу не подключён» —
 * это не ошибка, просто лампой никто не управляет.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {{kind?: string|null, device_id?: string|null, switch_code?: string|null,
 *          host?: string|null, channel?: number|null,
 *          on_url?: string|null, off_url?: string|null}} data
 */
export function setTableDevice(db, tableId, data = {}) {
  const table = getTable(db, tableId);
  const kind = String(data.kind ?? "").trim().toLowerCase() || null;
  if (kind !== null && !LIGHT_KINDS.has(kind)) {
    throw new ConflictError(
      `Неизвестный тип устройства «${kind}» (tuya, tasmota, shelly или url)`
    );
  }

  const deviceId = String(data.device_id ?? "").trim() || null;
  const code = String(data.switch_code ?? "").trim() || null;
  const host = String(data.host ?? "").trim() || null;
  const onUrl = String(data.on_url ?? "").trim() || null;
  const offUrl = String(data.off_url ?? "").trim() || null;
  const channel = Number(data.channel ?? 0);

  if (code !== null && !/^switch_[1-4]$/.test(code)) {
    throw new ConflictError(`Недопустимый канал реле «${code}» (switch_1 … switch_4)`);
  }
  if (!Number.isInteger(channel) || channel < 0 || channel > 7) {
    throw new ConflictError("Номер канала: целое число от 0 до 7");
  }
  if (kind === "tuya" && !deviceId) {
    throw new ConflictError("Для Tuya/MOES выберите устройство из списка");
  }
  if ((kind === "tasmota" || kind === "shelly") && !host) {
    throw new ConflictError(
      "Укажите адрес устройства в локальной сети — например 192.168.1.50"
    );
  }
  if (host !== null && /\s/.test(host)) {
    throw new ConflictError("В адресе устройства не должно быть пробелов");
  }
  if (kind === "url") {
    for (const [label, value] of [["включения", onUrl], ["выключения", offUrl]]) {
      if (!value) throw new ConflictError(`Укажите адрес ${label}`);
      if (!/^https?:\/\//i.test(value)) {
        throw new ConflictError(
          `Адрес ${label} должен начинаться с http:// или https://`
        );
      }
    }
  }

  db.prepare(
    `UPDATE tables
       SET light_kind = ?, tuya_device_id = ?, tuya_switch_code = ?,
           light_host = ?, light_channel = ?, light_on_url = ?, light_off_url = ?
     WHERE id = ?`
  ).run(
    kind,
    kind === "tuya" ? deviceId : null,
    kind === "tuya" ? code ?? "switch_1" : null,
    kind === "tasmota" || kind === "shelly" ? host : null,
    channel,
    kind === "url" ? onUrl : null,
    kind === "url" ? offUrl : null,
    table.id
  );
  return getTable(db, table.id);
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 * @param {string} [kind] billiard (по умолчанию), ps3 или ps5
 */
export function createTable(db, name, kind = "billiard") {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    throw new ConflictError("Название стола не может быть пустым");
  }
  if (!TABLE_KINDS.has(kind)) {
    throw new ConflictError(`Неизвестный тип точки «${kind}»`);
  }
  const exists = db.prepare("SELECT id FROM tables WHERE name = ?").get(trimmed);
  if (exists) {
    throw new ConflictError(`Стол с названием «${trimmed}» уже существует`);
  }
  const id = withTransaction(db, () => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO tables (name, status, created_at, kind) VALUES (?, 'free', ?, ?)")
      .run(trimmed, utcNow(), kind);
    const tableId = Number(lastInsertRowid);
    logEvent(db, JournalEvent.TABLE_CREATED, `Создан стол «${trimmed}»`, {
      tableId,
    });
    return tableId;
  });
  return getTable(db, id);
}

/**
 * Удаляет стол. В зале должен остаться хотя бы один активный стол, и у
 * стола не должно быть открытого сеанса. Если по столу уже есть история
 * сеансов — она не должна пропасть, поэтому стол не удаляется физически,
 * а просто скрывается (архивируется); если истории нет — удаляется совсем.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 */
export function deleteTable(db, tableId) {
  const table = getTable(db, tableId);
  if (table.status === "busy") {
    throw new ConflictError("Нельзя удалить стол с открытым сеансом — сначала закройте его");
  }
  const activeCount = db
    .prepare("SELECT COUNT(*) AS n FROM tables WHERE is_active = 1")
    .get().n;
  if (table.is_active && activeCount <= 1) {
    throw new ConflictError("Нельзя удалить последний стол — должен остаться хотя бы один");
  }
  const hasHistory = db
    .prepare("SELECT 1 FROM table_sessions WHERE table_id = ? LIMIT 1")
    .get(tableId);
  withTransaction(db, () => {
    if (hasHistory) {
      db.prepare("UPDATE tables SET is_active = 0 WHERE id = ?").run(tableId);
      logEvent(db, JournalEvent.TABLE_DELETED, `Удалён стол «${table.name}»`, { tableId });
    } else {
      // Стол ещё без истории — можно удалить строку целиком. Ссылку на
      // table_id в журнал не пишем: после удаления такого id уже не будет.
      db.prepare("DELETE FROM tables WHERE id = ?").run(tableId);
      logEvent(db, JournalEvent.TABLE_DELETED, `Удалён стол «${table.name}»`);
    }
  });
  return { ok: true };
}

/** Разрешённые тарифы для стола (id); пусто — можно выбрать любой активный тариф. */
export function getAllowedTariffIds(db, tableId) {
  return db
    .prepare("SELECT tariff_id FROM table_tariffs WHERE table_id = ? ORDER BY tariff_id")
    .all(tableId)
    .map((r) => r.tariff_id);
}

/**
 * Задаёт список тарифов, доступных для выбора на конкретном столе.
 * Обычно это один тариф — «цена этого стола», её назначает администратор,
 * а кассир потом просто открывает время. Несколько тарифов оставлены для
 * случая «днём одна цена, ночью другая»: выбрать нужный поможет расписание.
 * Пустой список снимает ограничение (снова доступны все активные тарифы).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {number[]} tariffIds
 * @param {{id: number, name: string} | null} [user] кто менял — для журнала
 */
export function setAllowedTariffIds(db, tableId, tariffIds, user = null) {
  const table = getTable(db, tableId); // бросит NotFoundError, если стола нет
  const ids = [...new Set(tariffIds)];
  for (const id of ids) {
    if (!Number.isInteger(id)) {
      throw new ConflictError("Список тарифов должен содержать целые id");
    }
  }
  const before = getAllowedTariffIds(db, tableId);
  withTransaction(db, () => {
    db.prepare("DELETE FROM table_tariffs WHERE table_id = ?").run(tableId);
    const insert = db.prepare(
      "INSERT INTO table_tariffs (table_id, tariff_id) VALUES (?, ?)"
    );
    for (const tariffId of ids) insert.run(tableId, tariffId);

    // Цена стола — деньги, поэтому смена видна владельцу в журнале.
    const changed = before.join(",") !== ids.join(",");
    if (changed) {
      const names = ids.length
        ? ids
            .map(
              (id) =>
                db.prepare("SELECT name FROM tariffs WHERE id = ?").get(id)?.name ??
                `id=${id}`
            )
            .map((name) => `«${name}»`)
            .join(", ")
        : "любой активный тариф";
      logEvent(
        db,
        JournalEvent.TARIFF_UPDATED,
        `Столу «${table.name}» назначен тариф: ${names}` +
          (user ? ` — ${user.name}` : ""),
        { tableId: table.id }
      );
    }
  });
  return getAllowedTariffIds(db, tableId);
}

/**
 * Тариф стола: тот, что назначил администратор. Если столу назначен ровно
 * один тариф — это и есть его цена, выбирать кассиру нечего. Если назначено
 * несколько или ничего — решает расписание (autoTariffId), а в крайнем
 * случае берётся первый активный тариф клуба.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {number | null} [autoTariffId] тариф по расписанию на сейчас
 * @returns {number | null} id тарифа или null, если тарифов в клубе нет
 */
export function resolveTableTariffId(db, tableId, autoTariffId = null) {
  const allowed = getAllowedTariffIds(db, tableId);
  const isActive = (id) =>
    id !== null &&
    id !== undefined &&
    db.prepare("SELECT is_active FROM tariffs WHERE id = ?").get(id)?.is_active === 1;

  if (allowed.length === 1 && isActive(allowed[0])) return allowed[0];
  if (allowed.length > 1) {
    // Несколько тарифов на столе: расписание выбирает из них.
    if (allowed.includes(autoTariffId) && isActive(autoTariffId)) return autoTariffId;
    const firstActive = allowed.find((id) => isActive(id));
    if (firstActive !== undefined) return firstActive;
  }
  if (isActive(autoTariffId)) return autoTariffId;
  return (
    db
      .prepare("SELECT id FROM tariffs WHERE is_active = 1 ORDER BY id LIMIT 1")
      .get()?.id ?? null
  );
}
