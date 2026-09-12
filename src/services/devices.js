// Устройства зала: кондиционер, вытяжка, приток. Это не столы — у них
// нет сеансов, тарифов и времени. Есть реле (те же драйверы, что и свет
// над столами) и цикл «поработало N минут — постояло M минут».
//
// Фаза цикла — арифметика от cycle_started_at: (сейчас − старт) mod
// (N + M) < N → должно быть включено. Ничего не накапливается, поэтому
// перезапуск программы, пропущенный тик или молчащее реле цикл не
// сбивают: следующий тик просто приводит реле к тому, что должно быть
// сейчас.

import { utcNow } from "../db.js";
import { logServerError } from "./diagnostics.js";
import { ConflictError, NotFoundError } from "./errors.js";
import {
  getDeviceController,
  parseRelayBinding,
  probeRelays,
  relayLastSeen,
  relayOnline,
} from "./lighting.js";

const FIELDS =
  "id, name, type, positions, position, work_minutes, rest_minutes, cycle_on, " +
  "cycle_started_at, is_on, light_kind, light_host, light_channel, light_on_url, " +
  "light_off_url, tuya_device_id, tuya_switch_code, net_ip, net_mac, created_at";

/**
 * Виды устройств. Кондиционер, вытяжка и приток — выключатель с циклом.
 * Решётка канала — привод с положениями («30,50,70»); решётка с одним
 * положением — по сути заслонка «открыто/закрыто» на обычном реле.
 */
export const DEVICE_TYPES = Object.freeze({
  ac: "Кондиционер",
  exhaust: "Вытяжка",
  intake: "Приток",
  damper: "Решётка канала",
});

/** Как часто сверяем реле с циклом. Минута точности для вытяжки — с запасом. */
export const TICK_MS = 30_000;

/**
 * Что цикл требует сейчас и через сколько секунд фаза сменится.
 * @param {{cycle_on: number|boolean, cycle_started_at: string|null,
 *   work_minutes: number, rest_minutes: number, is_on: number|boolean}} device
 * @param {number} [now] мс
 * @returns {{on: boolean, switchesIn: number|null}} null — цикл выключен
 *   или пауза нулевая (работает всегда)
 */
export function phaseOf(device, now = Date.now()) {
  if (!device.cycle_on || !device.cycle_started_at) {
    return { on: Boolean(device.is_on), switchesIn: null };
  }
  const work = device.work_minutes * 60_000;
  const period = work + device.rest_minutes * 60_000;
  const pos = Math.max(0, now - Date.parse(device.cycle_started_at)) % period;
  const on = pos < work;
  if (!device.rest_minutes) return { on: true, switchesIn: null };
  return { on, switchesIn: Math.ceil(((on ? work : period) - pos) / 1000) };
}

// Реле, которые не ответили на последнюю команду, — своё множество у
// каждой базы. По нему интерфейс отличает «реле молчит» от обычной
// задержки до ближайшего тика, а журнал ошибок получает одну запись,
// а не по одной каждые 30 секунд.
const failing = new WeakMap();

function failedSet(db) {
  let set = failing.get(db);
  if (!set) failing.set(db, (set = new Set()));
  return set;
}

function parsePositions(text) {
  return String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

function toOut(db, row, now) {
  const phase = phaseOf(row, now);
  return {
    ...row,
    positions: parsePositions(row.positions),
    cycle_on: Boolean(row.cycle_on),
    is_on: Boolean(row.is_on),
    // Чего требует цикл. Расходится с is_on — либо ближайший тик ещё не
    // дошёл (до 30 секунд), либо реле не отвечает — см. relay_error.
    should_be_on: phase.on,
    relay_error: failedSet(db).has(row.id),
    // В сети ли реле по последнему опросу; null — реле нет или не узнать.
    online: relayOnline(db, "device", row.id),
    last_seen: relayLastSeen(db, "device", row.id),
    switches_in_seconds: phase.switchesIn,
  };
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function listDevices(db, now = Date.now()) {
  return db
    .prepare(`SELECT ${FIELDS} FROM devices ORDER BY id`)
    .all()
    .map((row) => toOut(db, row, now));
}

/** @param {import("node:sqlite").DatabaseSync} db @param {number} id */
export function getDevice(db, id) {
  const row = db.prepare(`SELECT ${FIELDS} FROM devices WHERE id = ?`).get(id);
  if (!row) throw new NotFoundError("Устройство не найдено");
  return toOut(db, row, Date.now());
}

function parseFields(data) {
  const name = String(data.name ?? "").trim();
  if (!name) throw new ConflictError("Название устройства не может быть пустым");
  const type = String(data.type ?? "exhaust").trim();
  if (!(type in DEVICE_TYPES)) {
    throw new ConflictError(`Неизвестный вид устройства «${type}»`);
  }
  // У решётки вместо цикла — положения; у остальных положений нет.
  let positions = [];
  if (type === "damper") {
    positions = [...new Set(parsePositions(
      Array.isArray(data.positions) ? data.positions.join(",") : data.positions
    ))].sort((a, b) => a - b);
    if (!positions.length || positions.some((p) => !Number.isInteger(p) || p < 1 || p > 100)) {
      throw new ConflictError(
        "Положения решётки: проценты от 1 до 100 через запятую — например 30,50,70"
      );
    }
  }
  const work = Number(data.work_minutes ?? 15);
  const rest = Number(data.rest_minutes ?? 30);
  if (!Number.isInteger(work) || work < 1 || work > 1440) {
    throw new ConflictError("Сколько работает: целое число минут от 1 до 1440");
  }
  if (!Number.isInteger(rest) || rest < 0 || rest > 1440) {
    throw new ConflictError("Сколько стоит: целое число минут от 0 до 1440");
  }
  return { name, type, positions: positions.join(","), work, rest, relay: parseRelayBinding(data) };
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{name: string, work_minutes: number, rest_minutes: number,
 *   kind?: string|null, device_id?: string|null, switch_code?: string|null,
 *   host?: string|null, channel?: number|null, on_url?: string|null,
 *   off_url?: string|null}} data
 */
export function createDevice(db, data = {}) {
  const { name, type, positions, work, rest, relay } = parseFields(data);
  if (db.prepare("SELECT 1 FROM devices WHERE name = ?").get(name)) {
    throw new ConflictError(`Устройство «${name}» уже есть`);
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO devices (name, type, positions, work_minutes, rest_minutes, light_kind,
         light_host, light_channel, light_on_url, light_off_url, tuya_device_id,
         tuya_switch_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      type,
      positions,
      work,
      rest,
      relay.light_kind,
      relay.light_host,
      relay.light_channel,
      relay.light_on_url,
      relay.light_off_url,
      relay.tuya_device_id,
      relay.tuya_switch_code,
      utcNow()
    );
  return getDevice(db, Number(lastInsertRowid));
}

/** Полная замена полей (интерфейс всегда шлёт всю строку). */
export function updateDevice(db, id, data = {}) {
  getDevice(db, id);
  const { name, type, positions, work, rest, relay } = parseFields(data);
  if (db.prepare("SELECT 1 FROM devices WHERE name = ? AND id != ?").get(name, id)) {
    throw new ConflictError(`Устройство «${name}» уже есть`);
  }
  // Стало решёткой — цикл ей не положен.
  if (type === "damper") {
    db.prepare("UPDATE devices SET cycle_on = 0, cycle_started_at = NULL WHERE id = ?").run(id);
  }
  db.prepare(
    `UPDATE devices
       SET name = ?, type = ?, positions = ?, work_minutes = ?, rest_minutes = ?,
           light_kind = ?, light_host = ?, light_channel = ?, light_on_url = ?,
           light_off_url = ?, tuya_device_id = ?, tuya_switch_code = ?
     WHERE id = ?`
  ).run(
    name,
    type,
    positions,
    work,
    rest,
    relay.light_kind,
    relay.light_host,
    relay.light_channel,
    relay.light_on_url,
    relay.light_off_url,
    relay.tuya_device_id,
    relay.tuya_switch_code,
    id
  );
  return getDevice(db, id);
}

/** Удаляет устройство; включённое — сначала пытается выключить. */
export async function deleteDevice(db, id) {
  const device = getDevice(db, id);
  if (device.is_on) {
    await getDeviceController(db).setLight(id, false).catch(() => {});
  }
  db.prepare("DELETE FROM devices WHERE id = ?").run(id);
  return device;
}

/** Щёлкает реле и запоминает результат; ошибку реле показывает как есть. */
async function applyPower(db, id, on) {
  const failed = failedSet(db);
  try {
    await getDeviceController(db).setLight(id, on);
  } catch (error) {
    failed.add(id);
    throw new ConflictError(error.message);
  }
  failed.delete(id);
  db.prepare("UPDATE devices SET is_on = ? WHERE id = ?").run(on ? 1 : 0, id);
}

/**
 * Включить или выключить руками. Если цикл идёт, он начинается заново с
 * этой фазы: «включить» — полные N минут работы, «выключить» — полные
 * M минут паузы, дальше как обычно.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export async function setDevicePower(db, id, on, now = Date.now()) {
  const device = getDevice(db, id);
  // У решётки «включить» — открыть до упора, «выключить» — закрыть.
  if (device.type === "damper") {
    return setDevicePosition(db, id, on ? Math.max(...device.positions) : 0);
  }
  await applyPower(db, id, on);
  if (device.cycle_on) {
    const anchor = on ? now : now - device.work_minutes * 60_000;
    db.prepare("UPDATE devices SET cycle_started_at = ? WHERE id = ?").run(
      new Date(anchor).toISOString(),
      id
    );
  }
  return getDevice(db, id);
}

/**
 * Включить цикл (начинается с работы) или выключить его — вместе с
 * устройством: ничто не должно крутиться без присмотра. Состояние цикла
 * сохраняется до попытки щёлкнуть реле: даже если реле промолчало,
 * цикл включён и следующий тик попробует снова.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export async function setDeviceCycle(db, id, on, now = Date.now()) {
  const device = getDevice(db, id);
  if (device.type === "damper") {
    throw new ConflictError("У решётки нет цикла — выберите положение");
  }
  db.prepare("UPDATE devices SET cycle_on = ?, cycle_started_at = ? WHERE id = ?").run(
    on ? 1 : 0,
    on ? new Date(now).toISOString() : null,
    id
  );
  await applyPower(db, id, on);
  return getDevice(db, id);
}

/**
 * Положение решётки канала в процентах: 0 — закрыта, иначе одно из её
 * положений. Решётка с несколькими положениями — привод (команда
 * «встать на N %»), с одним — обычное реле: открыто/закрыто.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export async function setDevicePosition(db, id, percent) {
  const device = getDevice(db, id);
  if (device.type !== "damper") {
    throw new ConflictError("Положение задаётся только решётке канала");
  }
  const value = Number(percent);
  if (value !== 0 && !device.positions.includes(value)) {
    throw new ConflictError(
      `У решётки «${device.name}» нет положения ${percent}% (есть: ${device.positions.join(", ")})`
    );
  }
  const failed = failedSet(db);
  try {
    if (device.positions.length > 1) {
      await getDeviceController(db).setPosition(id, value);
    } else {
      await getDeviceController(db).setLight(id, value > 0);
    }
  } catch (error) {
    failed.add(id);
    throw new ConflictError(error.message);
  }
  failed.delete(id);
  db.prepare("UPDATE devices SET position = ?, is_on = ? WHERE id = ?").run(
    value,
    value > 0 ? 1 : 0,
    id
  );
  return getDevice(db, id);
}

/**
 * Приводит реле к тому, что требует цикл. Вызывается по таймеру и при
 * старте программы.
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {Promise<{switched: number}>}
 */
export async function runDeviceCycles(db, now = Date.now()) {
  const rows = db.prepare(`SELECT ${FIELDS} FROM devices WHERE cycle_on = 1`).all();
  const failed = failedSet(db);
  let switched = 0;
  for (const row of rows) {
    const { on } = phaseOf(row, now);
    if (on === Boolean(row.is_on)) continue;
    const wasFailing = failed.has(row.id);
    try {
      await applyPower(db, row.id, on);
      switched += 1;
    } catch (error) {
      // Молчащее реле — одна запись в журнал ошибок, пока не оживёт.
      if (!wasFailing) logServerError(new Error(`Устройство «${row.name}»: ${error.message}`));
    }
  }
  return { switched };
}

/**
 * Запускает цикл устройств для этой базы: сразу и дальше по таймеру.
 * Тем же тиком опрашиваются все реле — над столами и у устройств, —
 * чтобы в интерфейсе было видно, кто в сети.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function startDeviceCycles(db) {
  const run = () =>
    runDeviceCycles(db)
      .catch(() => {})
      .then(() => probeRelays(db))
      .catch(() => {});
  run();
  const timer = setInterval(run, TICK_MS);
  timer.unref?.(); // таймер не должен мешать программе закрыться
  return timer;
}
