// Управление освещением столов.
//
// Frontend и HTTP-слой ничего не знают об оборудовании — они работают
// только с контроллером из getLightingController(). Доступны два драйвера:
//   mock — состояние в памяти процесса (по умолчанию, ничего не требует);
//   tuya — реальные Wi-Fi реле Tuya/MOES (WM4LT1 и совместимые) через
//          Tuya Cloud API.
//
// Драйвер, ключи облака и привязка столов к реле настраиваются во вкладке
// «Настройки» интерфейса и хранятся в базе; initLighting перечитывает их
// при старте сервера и после каждого сохранения настроек.

import { ConflictError, NotFoundError } from "./errors.js";
import { getSettings } from "./settings.js";
import { HttpLightingController, HTTP_KINDS } from "./lighting-http.js";
import { TuyaLightingController } from "./lighting-tuya.js";

/** Чем может управляться реле: свет над столом или устройство зала. */
export const LIGHT_KINDS = new Set(["tuya", "tasmota", "shelly", "url"]);

/**
 * Разбор и проверка привязки к реле — одна на столы и на устройства зала.
 *
 * tuya — облако Tuya/MOES: нужны id устройства и канал (switch_1 …);
 * tasmota и shelly — реле в локальной сети: адрес (IP) и номер канала;
 * url — «своё устройство»: два адреса, включить и выключить.
 * Пустой kind — «реле не подключено»: это не ошибка.
 *
 * @param {{kind?: string|null, device_id?: string|null, switch_code?: string|null,
 *          host?: string|null, channel?: number|null,
 *          on_url?: string|null, off_url?: string|null}} data
 * @returns {{light_kind: string|null, tuya_device_id: string|null,
 *   tuya_switch_code: string|null, light_host: string|null, light_channel: number,
 *   light_on_url: string|null, light_off_url: string|null}} колонки как в базе
 */
export function parseRelayBinding(data = {}) {
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

  return {
    light_kind: kind,
    tuya_device_id: kind === "tuya" ? deviceId : null,
    tuya_switch_code: kind === "tuya" ? code ?? "switch_1" : null,
    light_host: kind === "tasmota" || kind === "shelly" ? host : null,
    light_channel: channel,
    light_on_url: kind === "url" ? onUrl : null,
    light_off_url: kind === "url" ? offUrl : null,
  };
}

export class MockLightingController {
  #on = new Set();
  #positions = new Map();

  /** @param {number} tableId */
  turnLightOn(tableId) {
    this.#on.add(tableId);
    console.info(`Mock lighting: light ON for table ${tableId}`);
  }

  /** @param {number} tableId */
  turnLightOff(tableId) {
    this.#on.delete(tableId);
    console.info(`Mock lighting: light OFF for table ${tableId}`);
  }

  /** @param {number} tableId */
  isLightOn(tableId) {
    return this.#on.has(tableId);
  }

  /**
   * Ручное управление. У заглушки всё всегда получается — так кнопки
   * «Включить/выключить свет» можно проверить и без реле.
   * @param {number} tableId @param {boolean} value
   */
  async setLight(tableId, value) {
    if (value) this.turnLightOn(tableId);
    else this.turnLightOff(tableId);
    return true;
  }

  /** @param {number} tableId */
  async readLight(tableId) {
    return this.#on.has(tableId);
  }

  /** Положение решётки/заслонки в процентах — у заглушки просто память. */
  async setPosition(id, percent) {
    this.#positions.set(id, percent);
    console.info(`Mock lighting: position ${percent}% for device ${id}`);
    return true;
  }

  positionOf(id) {
    return this.#positions.get(id) ?? 0;
  }

  /** Реле нет — и связи с ним нет: ни «в сети», ни «нет связи». */
  async probe() {
    return { online: null };
  }
}

/**
 * Общий контроллер: у каждого стола своё устройство. В одном клубе можно
 * держать и облачные реле Tuya/MOES, и локальные Tasmota или Shelly —
 * это не редкость: докупают то, что нашлось в магазине.
 *
 * Стол без привязки просто запоминает состояние в памяти: программа
 * работает, лампой никто не управляет.
 */
class CompositeLightingController {
  #resolveRow;
  #tuya;
  #http;
  #memory = new MockLightingController();

  /**
   * @param {(tableId: number) => object|null} resolveRow строка стола из базы
   * @param {TuyaLightingController|null} tuya
   */
  constructor(resolveRow, tuya) {
    this.#resolveRow = resolveRow;
    this.#tuya = tuya;
    this.#http = new HttpLightingController((tableId) => {
      const row = this.#resolveRow(tableId);
      if (!row?.light_kind || !HTTP_KINDS.includes(row.light_kind)) return null;
      return {
        kind: row.light_kind,
        host: row.light_host,
        channel: row.light_channel ?? 0,
        on_url: row.light_on_url,
        off_url: row.light_off_url,
      };
    });
  }

  /** Кто отвечает за этот стол. */
  #backendFor(tableId) {
    const row = this.#resolveRow(tableId);
    if (row?.light_kind && HTTP_KINDS.includes(row.light_kind)) return this.#http;
    // Старые базы: тип не указан, но устройство Tuya привязано.
    if (this.#tuya && row?.tuya_device_id) return this.#tuya;
    return this.#memory;
  }

  turnLightOn(tableId) {
    this.#memory.turnLightOn(tableId);
    const backend = this.#backendFor(tableId);
    if (backend !== this.#memory) backend.turnLightOn(tableId);
  }

  turnLightOff(tableId) {
    this.#memory.turnLightOff(tableId);
    const backend = this.#backendFor(tableId);
    if (backend !== this.#memory) backend.turnLightOff(tableId);
  }

  isLightOn(tableId) {
    return this.#memory.isLightOn(tableId);
  }

  async setLight(tableId, value) {
    const backend = this.#backendFor(tableId);
    if (backend !== this.#memory) await backend.setLight(tableId, value);
    await this.#memory.setLight(tableId, value);
    return true;
  }

  async readLight(tableId) {
    const backend = this.#backendFor(tableId);
    if (backend === this.#memory) return this.#memory.readLight(tableId);
    const state = await backend.readLight(tableId);
    if (state === true) this.#memory.turnLightOn(tableId);
    if (state === false) this.#memory.turnLightOff(tableId);
    return state;
  }

  /** Положение привода (решётка канала) в процентах: 0 — закрыто. */
  async setPosition(id, percent) {
    const backend = this.#backendFor(id);
    if (backend !== this.#memory) await backend.setPosition(id, percent);
    await this.#memory.setPosition(id, percent);
    return true;
  }

  /**
   * Опрос реле: в сети ли (null — не привязано или узнать нельзя) и
   * что оно сообщило о себе (IP, MAC).
   * @returns {Promise<{online: boolean|null, ip?: string, mac?: string}>}
   */
  async probe(id) {
    const backend = this.#backendFor(id);
    if (backend === this.#memory) return { online: null };
    return backend.probe(id);
  }
}

// «В сети ли реле» — ответ опроса, а не догадка: раз в полминуты
// программа спрашивает каждое реле (см. probeRelays), а интерфейс
// показывает последний ответ. Кэш свой у каждой базы.
const onlineStates = new WeakMap();

/**
 * Последний известный ответ реле: true — в сети, false — не отвечает,
 * null — не опрашивали, не привязано или узнать нельзя.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {"table"|"device"} scope
 * @param {number} id
 */
export function relayOnline(db, scope, id) {
  return onlineStates.get(db)?.get(`${scope}:${id}`)?.online ?? null;
}

/**
 * Когда реле последний раз выходило на связь (ISO), null — ни разу с
 * запуска программы. Держится в памяти: после перезапуска отсчёт заново.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {"table"|"device"} scope
 * @param {number} id
 */
export function relayLastSeen(db, scope, id) {
  return onlineStates.get(db)?.get(`${scope}:${id}`)?.lastSeen ?? null;
}

function remember(map, key, online) {
  const prev = map.get(key);
  map.set(key, {
    online,
    lastSeen: online ? new Date().toISOString() : (prev?.lastSeen ?? null),
  });
}

/**
 * Опрашивает все привязанные реле — над столами и у устройств зала —
 * и запоминает, кто ответил. Параллельно: молчащее реле ждём не дольше
 * его таймаута, а не по очереди. Ошибки не важны: касса от них не
 * зависит.
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {Promise<{probed: number}>}
 */
export async function probeRelays(db) {
  let map = onlineStates.get(db);
  if (!map) onlineStates.set(db, (map = new Map()));
  const bound =
    "((light_kind IS NOT NULL AND light_kind != '') OR (tuya_device_id IS NOT NULL AND tuya_device_id != ''))";
  const tables = db.prepare(`SELECT id FROM tables WHERE is_active = 1 AND ${bound}`).all();
  const devices = db.prepare(`SELECT id FROM devices WHERE ${bound}`).all();
  const { controller, devices: deviceController } = stateFor(db);
  const probeOne = async (scope, id, ctrl) => {
    const info = await ctrl.probe(id).catch(() => ({ online: null }));
    remember(map, `${scope}:${id}`, info.online);
    // Что реле рассказало о себе — запоминаем в базе: так IP и MAC
    // видны в интерфейсе и после перезапуска, а вписанное руками
    // остаётся, пока устройство само не сообщит другое.
    if (info.ip || info.mac) {
      try {
        db.prepare(
          `UPDATE ${scope === "table" ? "tables" : "devices"}
             SET net_ip = COALESCE(?, net_ip), net_mac = COALESCE(?, net_mac)
           WHERE id = ?`
        ).run(info.ip ?? null, info.mac ? normalizeMac(info.mac) : null, id);
      } catch {
        // Устройство прислало что-то не похожее на MAC — не наша беда.
      }
    }
  };
  await Promise.all([
    ...tables.map(({ id }) => probeOne("table", id, controller)),
    ...devices.map(({ id }) => probeOne("device", id, deviceController)),
  ]);
  return { probed: tables.length + devices.length };
}

/** MAC в одном виде: A4:CF:12:34:56:78. Пустая строка — нет MAC. */
function normalizeMac(value) {
  const text = String(value ?? "").trim().toUpperCase().replaceAll("-", ":");
  if (!text) return null;
  const compact = text.replaceAll(":", "");
  if (!/^[0-9A-F]{12}$/.test(compact)) {
    throw new ConflictError(
      "MAC — шесть пар шестнадцатеричных цифр через двоеточие, например A4:CF:12:34:56:78"
    );
  }
  return compact.match(/.{2}/g).join(":");
}

/**
 * IP и MAC реле, вписанные руками. У локального реле (Tasmota, Shelly)
 * IP — это и есть адрес, по которому его дёргают: сменился адрес —
 * правят здесь, и реле снова отвечает. У облачных и «своих» IP — просто
 * запись.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {"table"|"device"} scope
 * @param {number} id
 * @param {{ip?: string|null, mac?: string|null}} data
 */
export function setRelayNet(db, scope, id, data = {}) {
  const table = scope === "table" ? "tables" : "devices";
  const row = db.prepare(`SELECT light_kind FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new NotFoundError(scope === "table" ? "Стол не найден" : "Устройство не найдено");
  const ip = String(data.ip ?? "").trim();
  if (/\s/.test(ip)) throw new ConflictError("В адресе не должно быть пробелов");
  const mac = normalizeMac(data.mac);
  const local = row.light_kind === "tasmota" || row.light_kind === "shelly";
  if (local && !ip) {
    throw new ConflictError("У реле в локальной сети адрес нужен — без него его не дёрнуть");
  }
  db.prepare(
    `UPDATE ${table} SET ${local ? "light_host" : "net_ip"} = ?, net_mac = ? WHERE id = ?`
  ).run(ip || null, mac, id);
}

// Состояние драйвера — своё у каждой базы. В сети клубов все клубы
// работают в одном процессе, и один общий контроллер отправлял бы
// команду одного клуба на реле (или в облачный аккаунт) другого.
const states = new WeakMap();

function stateFor(db) {
  let state = states.get(db);
  if (!state) {
    state = {
      controller: new MockLightingController(),
      devices: new MockLightingController(),
      tuyaClient: null,
      driver: "mock",
    };
    states.set(db, state);
  }
  return state;
}

/**
 * (Пере)инициализация драйвера по настройкам из базы. Вызывается при старте
 * сервера и после сохранения настроек. Никогда не бросает: при некорректной
 * конфигурации сервер продолжает работать на Mock, чтобы касса не зависела
 * от облака.
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {Promise<{driver: "mock"|"tuya", error?: string}>}
 */
export async function initLighting(db) {
  const settings = getSettings(db);
  const state = stateFor(db);
  state.tuyaClient = null;

  // Строка стола (или устройства зала): по ней общий контроллер понимает,
  // куда слать команду. Колонки реле у devices названы как у tables —
  // ради вот этого общего кода.
  const RELAY_COLUMNS =
    "tuya_device_id, tuya_switch_code, light_kind, light_host, light_channel, light_on_url, light_off_url";
  const resolveRow = (tableId) =>
    db.prepare(`SELECT ${RELAY_COLUMNS} FROM tables WHERE id = ?`).get(tableId) ?? null;
  const resolveDeviceRow = (deviceId) =>
    db.prepare(`SELECT ${RELAY_COLUMNS} FROM devices WHERE id = ?`).get(deviceId) ?? null;
  const tuyaFor = (client, resolve) =>
    new TuyaLightingController(client, (id) => {
      const row = resolve(id);
      return row ? { device_id: row.tuya_device_id, switch_code: row.tuya_switch_code } : null;
    });

  // Локальные реле (Tasmota, Shelly, свой адрес) работают всегда: им не
  // нужны ни ключи, ни интернет. Облако Tuya подключаем, если настроено.
  let tuya = null;
  let error = null;
  if (settings.lighting_driver === "tuya") {
    try {
      if (!settings.tuya_access_id || !settings.tuya_access_secret) {
        throw new Error("не заполнены Access ID и Access Secret");
      }
      // Импортируем пакет только когда драйвер действительно нужен.
      const { TuyaContext } = await import("@tuya/tuya-connector-nodejs");
      state.tuyaClient = new TuyaContext({
        baseUrl: settings.tuya_api_host,
        accessKey: settings.tuya_access_id,
        secretKey: settings.tuya_access_secret,
      });
      tuya = tuyaFor(state.tuyaClient, resolveRow);
      console.info("Tuya lighting: драйвер включён");
    } catch (err) {
      error = err.message;
      state.tuyaClient = null;
      tuya = null;
      console.error(
        `Tuya lighting: не удалось включить драйвер (${err.message}). ` +
          "Столы на облачных реле останутся без управления светом; " +
          "локальные реле (Tasmota, Shelly) продолжат работать."
      );
    }
  }

  state.controller = new CompositeLightingController(resolveRow, tuya);
  // Устройства зала (кондиционер, вытяжка, приток) — те же драйверы, но
  // свой контроллер: у столов и устройств разные номера.
  state.devices = new CompositeLightingController(
    resolveDeviceRow,
    tuya ? tuyaFor(state.tuyaClient, resolveDeviceRow) : null
  );
  state.driver = tuya ? "tuya" : "mock";
  return error ? { driver: state.driver, error } : { driver: state.driver };
}

/**
 * Текущий контроллер освещения этой базы.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function getLightingController(db) {
  return stateFor(db).controller;
}

/**
 * Контроллер реле устройств зала этой базы (см. services/devices.js).
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function getDeviceController(db) {
  return stateFor(db).devices;
}

/**
 * Приводит свет в зале в соответствие с тем, что показывает программа:
 * над занятыми столами включает, над свободными — гасит.
 *
 * Нужно после перезапуска программы и когда свет щёлкали руками: иначе
 * над пустым столом всю ночь горит лампа, а гость сидит в темноте.
 * Ошибки не важны: если облако недоступно, касса всё равно работает.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {Promise<{synced: number}>}
 */
export async function syncLighting(db) {
  const rows = db
    .prepare(
      `SELECT t.id,
              EXISTS (SELECT 1 FROM table_sessions s
                       WHERE s.table_id = t.id AND s.ended_at IS NULL) AS busy
       FROM tables t
       WHERE t.is_active = 1
         AND ((t.light_kind IS NOT NULL AND t.light_kind != '')
              OR (t.tuya_device_id IS NOT NULL AND t.tuya_device_id != ''))`
    )
    .all();
  const { controller } = stateFor(db);
  let synced = 0;
  for (const row of rows) {
    const shouldBeOn = Boolean(row.busy);
    const actual = await controller.readLight(row.id);
    if (actual === shouldBeOn) continue;
    try {
      await controller.setLight(row.id, shouldBeOn);
      synced += 1;
    } catch (error) {
      console.error(
        `Свет над столом ${row.id}: не удалось привести в порядок (${error.message})`
      );
    }
  }
  if (synced) console.info(`Свет: приведено в соответствие столов — ${synced}`);
  return { synced };
}

/** Имя активного драйвера ("mock" | "tuya") — для вкладки «Настройки». */
export function getActiveDriver(db) {
  return stateFor(db).driver;
}

/**
 * Список устройств из аккаунта Tuya — для выпадающих списков во вкладке
 * «Настройки». Требует включённого драйвера tuya.
 * @returns {Promise<Array<{id: string, name: string, online: boolean|null}>>}
 */
export async function listCloudDevices(db) {
  const { tuyaClient } = stateFor(db);
  if (!tuyaClient) {
    throw new ConflictError(
      "Подключение Tuya не настроено: включите драйвер, заполните ключи и нажмите «Сохранить»"
    );
  }
  const response = await tuyaClient.request({
    method: "GET",
    path: "/v1.0/iot-01/associated-users/devices?size=100",
  });
  if (!response?.success) {
    throw new ConflictError(
      `Tuya отклонил запрос списка устройств: ${response?.msg ?? response?.code ?? "нет ответа"}`
    );
  }
  const devices = response.result?.devices ?? response.result?.list ?? [];
  return devices.map((d) => ({
    id: d.id,
    name: d.name ?? d.id,
    online: typeof d.online === "boolean" ? d.online : null,
  }));
}
