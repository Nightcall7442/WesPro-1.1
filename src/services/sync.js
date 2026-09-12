// Синхронизация клуба, который работает у себя (exe или start-club.bat),
// с сетью WesPro. Программа целиком офлайновая: считает деньги и
// открывает столы без интернета. А когда интернет есть, раз в минуту:
//
//   • отмечается в панели сети (ping): подписка, сообщения, новшества;
//   • если в базе что-то менялось — отправляет её снимок целиком. По
//     снимку панель показывает офлайн-клуб так же, как облачный:
//     столы, выручка, смены, сотрудники, журнал.
//
// Нет интернета — тихо ждём следующей минуты; накопленное уедет одним
// снимком, когда связь появится. Снимок — это копия базы (VACUUM INTO),
// поэтому «синхронизировалось всё» — буквально всё.

import fs from "node:fs";

import { exportBackupFile } from "./backup.js";
import { logServerError } from "./diagnostics.js";
import { checkSubscription, hubConfig } from "./subscription.js";

const TICK_MS = 60 * 1000;
/** Сколько ждём загрузку снимка: база в несколько мегабайт по медленной сети. */
const UPLOAD_TIMEOUT_MS = 120 * 1000;

// Состояние синхронизации — своё у каждой базы.
const states = new WeakMap();

function stateFor(db) {
  let state = states.get(db);
  if (!state) {
    state = {
      sentVersion: null, // PRAGMA data_version на момент последнего снимка
      lastPingAt: null,
      lastSnapshotAt: null,
      lastError: null,
      running: false,
      timer: null,
    };
    states.set(db, state);
  }
  return state;
}

/**
 * Отпечаток «менялось ли что-то»: total_changes() считает строки,
 * изменённые этим подключением (программа пишет через него), а
 * data_version растёт, когда пишет кто-то другой (add-user из консоли).
 */
function dataVersion(db) {
  const own = db.prepare("SELECT total_changes() AS n").get().n;
  const others = db.prepare("PRAGMA data_version").get().data_version;
  return `${others}:${own}`;
}

/** Отправляет снимок базы в панель сети. */
async function uploadSnapshot(db, config) {
  const file = exportBackupFile(db);
  try {
    const body = fs.readFileSync(file);
    const response = await fetch(`${config.url}/hub/api/agent/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Club-Key": config.key },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.json().then((b) => b.detail).catch(() => null);
      throw new Error(detail ?? `панель ответила ${response.status}`);
    }
  } finally {
    fs.unlink(file, () => {});
  }
}

/**
 * Один проход синхронизации: ping и, если надо, снимок. Ничего не
 * бросает — результат в syncStatus().
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{force?: boolean}} [options] force — снимок даже без изменений
 */
export async function runSync(db, { force = false } = {}) {
  const state = stateFor(db);
  const config = hubConfig(db);
  if (!config || state.running) return syncStatus(db);
  state.running = true;
  try {
    const ping = await checkSubscription(db);
    if (!ping.connected) {
      state.lastError = ping.error ?? "нет связи";
      return syncStatus(db);
    }
    state.lastPingAt = new Date().toISOString();
    state.lastError = null;

    const version = dataVersion(db);
    if (force || state.sentVersion === null || version !== state.sentVersion) {
      await uploadSnapshot(db, config);
      state.sentVersion = dataVersion(db);
      state.lastSnapshotAt = new Date().toISOString();
    }
  } catch (error) {
    state.lastError = error.name === "TimeoutError" ? "снимок не успел загрузиться" : error.message;
    logServerError(new Error(`Синхронизация с сетью WesPro: ${state.lastError}`));
  } finally {
    state.running = false;
  }
  return syncStatus(db);
}

/**
 * Что показать в «Настройках» → «Подписка»: когда последний раз были на
 * связи и когда уехал последний снимок.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function syncStatus(db) {
  const state = stateFor(db);
  return {
    configured: Boolean(hubConfig(db)),
    last_ping_at: state.lastPingAt,
    last_snapshot_at: state.lastSnapshotAt,
    pending: state.sentVersion === null || dataVersion(db) !== state.sentVersion,
    error: state.lastError,
    running: state.running,
  };
}

/**
 * Запускает синхронизацию по таймеру: сразу и дальше раз в минуту.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function startSync(db) {
  const state = stateFor(db);
  const run = () => runSync(db).catch(() => {});
  run();
  state.timer = setInterval(run, TICK_MS);
  state.timer.unref?.(); // таймер не должен мешать программе закрыться
  return state.timer;
}

export function stopSync(db) {
  const state = stateFor(db);
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
