// Локальные ключи реле Tuya — одной кнопкой из облака.
//
// Реле Tuya по локальной сети шифрует команды своим ключом (local_key), а
// выдаёт его только облако iot.tuya.com. Раньше ключ копировали руками из
// API Explorer — и теряли символы. Теперь программа сама спрашивает облако
// по ключам проекта (Access ID и Secret из «Настроек»): ключи всех реле
// приложения Smart Life ложатся в таблицу tuya_keys, уже привязанные к
// столам реле получают новый ключ сразу, а при новой привязке ключ
// подставляется сам. Наружу ключи не отдаются никогда — как пароли.

import { utcNow } from "../db.js";
import { ConflictError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";
import { localKeyToStore, recentTuyaAnnouncements, tuyaCloudClient } from "./lighting.js";

/** Сколько устройств спрашиваем у облака за раз — больше в клубе не бывает. */
const MAX_DEVICES = 100;

/**
 * Ключ реле, полученный из облака раньше, или null.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string|null} deviceId
 */
export function knownTuyaKey(db, deviceId) {
  if (!deviceId) return null;
  return (
    db.prepare("SELECT local_key FROM tuya_keys WHERE device_id = ?").get(deviceId)?.local_key ??
    null
  );
}

/**
 * Какой локальный ключ записать в привязку стола или устройства зала.
 * Порядок: вписанный руками → сохранённый у этой же привязки (если реле
 * то же самое) → полученный из облака. Ключ от другого реле не подходит,
 * поэтому сменили ID — сохранённый ключ не наследуется.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {"tables"|"devices"} table
 * @param {number|null} id строка, которую правят; null — новая
 * @param {ReturnType<import("./lighting.js").parseRelayBinding>} relay
 */
export function localKeyFor(db, table, id, relay) {
  const stored =
    id === null
      ? null
      : db.prepare(`SELECT tuya_device_id, tuya_local_key FROM ${table} WHERE id = ?`).get(id);
  const sameDevice = stored && stored.tuya_device_id === relay.tuya_device_id;
  return localKeyToStore(
    relay,
    (sameDevice ? stored.tuya_local_key : null) ?? knownTuyaKey(db, relay.tuya_device_id)
  );
}

/**
 * Реле, ключи которых уже получены: ID и имя из Smart Life — для
 * подсказок в «Настройках». Сами ключи не возвращаются.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function listTuyaKeys(db) {
  const lan = new Map(recentTuyaAnnouncements().map((d) => [d.id, d]));
  return db
    .prepare("SELECT device_id AS id, name, fetched_at FROM tuya_keys ORDER BY name, device_id")
    .all()
    .map((row) => ({
      ...row,
      ip: lan.get(row.id)?.ip ?? null,
      version: lan.get(row.id)?.version ?? null,
    }));
}

/** Подробности устройства из облака: новый API, а если не пустил — старый. */
async function deviceDetails(client, id) {
  let reason = "нет ответа";
  for (const path of [`/v2.0/cloud/thing/${id}`, `/v1.0/devices/${id}`]) {
    try {
      const response = await client.request({ method: "GET", path });
      if (response?.success && response.result?.local_key) return { details: response.result };
      reason = response?.msg ?? response?.code ?? reason;
    } catch (error) {
      reason = error.message;
    }
  }
  return { reason: String(reason) };
}

/** Какие столы и устройства зала привязаны к реле с этим ID — по именам. */
function boundNames(db, id) {
  return [
    ...db
      .prepare("SELECT name FROM tables WHERE light_kind = 'tuya_local' AND tuya_device_id = ? AND is_active = 1")
      .all(id),
    ...db.prepare("SELECT name FROM devices WHERE light_kind = 'tuya_local' AND tuya_device_id = ?").all(id),
  ].map((row) => row.name);
}

/**
 * Забирает из облака Tuya локальные ключи реле: всех устройств
 * приложения Smart Life, привязанного к проекту, плюс уже привязанных к
 * столам и найденных в сети. Ключи кладёт в tuya_keys и сразу обновляет
 * привязки, где ключ устарел (реле заново спарили).
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {Promise<{devices: Array<{id: string, name: string|null,
 *   ip: string|null, version: string|null, online: boolean|null,
 *   bound_to: string[]}>, updated: number, failed: Array<{id: string, reason: string}>}>}
 */
export async function fetchTuyaKeys(db) {
  const client = await tuyaCloudClient(db);

  // Кого спрашивать: устройства приложения (с именами из Smart Life) +
  // уже привязанные + те, кто сейчас слышен в сети.
  const wanted = new Map();
  let listReason = null;
  try {
    const response = await client.request({
      method: "GET",
      path: `/v1.0/iot-01/associated-users/devices?size=${MAX_DEVICES}`,
    });
    if (response?.success) {
      for (const d of response.result?.devices ?? response.result?.list ?? []) {
        if (d?.id) wanted.set(String(d.id), d.name ?? null);
      }
    } else {
      listReason = response?.msg ?? response?.code ?? null;
    }
  } catch (error) {
    listReason = error.message;
  }
  const bound = db
    .prepare(
      `SELECT tuya_device_id AS id FROM tables WHERE light_kind = 'tuya_local'
       UNION SELECT tuya_device_id FROM devices WHERE light_kind = 'tuya_local'`
    )
    .all();
  const lan = new Map(recentTuyaAnnouncements().map((d) => [d.id, d]));
  for (const id of [...bound.map((row) => row.id), ...lan.keys()]) {
    if (id && !wanted.has(id)) wanted.set(id, null);
  }
  if (!wanted.size) {
    throw new ConflictError(
      "Облако Tuya не показало ни одного устройства" +
        (listReason ? ` (${listReason})` : "") +
        ". Привяжите приложение Smart Life к проекту: Devices → Link Tuya App Account."
    );
  }

  const devices = [];
  const failed = [];
  let updated = 0;
  for (const [id, listedName] of [...wanted].slice(0, MAX_DEVICES)) {
    if (!/^[A-Za-z0-9]+$/.test(id)) continue;
    const { details, reason } = await deviceDetails(client, id);
    const key = String(details?.local_key ?? "");
    if (!/^[\x21-\x7e]{16}$/.test(key)) {
      failed.push({ id, reason: details ? "облако отдало ключ не того вида" : reason });
      continue;
    }
    const name = details.name ?? listedName ?? null;
    db.prepare(
      `INSERT INTO tuya_keys (device_id, local_key, name, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET
         local_key = excluded.local_key, name = excluded.name, fetched_at = excluded.fetched_at`
    ).run(id, key, name, utcNow());
    for (const table of ["tables", "devices"]) {
      updated += Number(
        db
          .prepare(
            `UPDATE ${table} SET tuya_local_key = ?
             WHERE light_kind = 'tuya_local' AND tuya_device_id = ?
               AND (tuya_local_key IS NULL OR tuya_local_key != ?)`
          )
          .run(key, id, key).changes
      );
    }
    devices.push({
      id,
      name,
      ip: lan.get(id)?.ip ?? null,
      version: lan.get(id)?.version ?? null,
      online: typeof details.is_online === "boolean" ? details.is_online
        : typeof details.online === "boolean" ? details.online : null,
      bound_to: boundNames(db, id),
    });
  }

  if (!devices.length) {
    throw new ConflictError(
      `Облако Tuya не отдало ключи: ${failed[0]?.reason ?? "нет ответа"}. ` +
        "Проверьте дата-центр и что у проекта подключены сервисы IoT Core и Authorization."
    );
  }
  logEvent(
    db,
    JournalEvent.SETTINGS_UPDATED,
    `Получены ключи реле Tuya из облака: ${devices.length}` +
      (updated ? `, обновлено привязок: ${updated}` : "")
  );
  return { devices, updated, failed };
}
