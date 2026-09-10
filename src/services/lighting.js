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

import { ConflictError } from "./errors.js";
import { getSettings } from "./settings.js";
import { HttpLightingController, HTTP_KINDS } from "./lighting-http.js";
import { TuyaLightingController } from "./lighting-tuya.js";

export class MockLightingController {
  #on = new Set();

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
}

// Состояние драйвера — своё у каждой базы. В сети клубов все клубы
// работают в одном процессе, и один общий контроллер отправлял бы
// команду одного клуба на реле (или в облачный аккаунт) другого.
const states = new WeakMap();

function stateFor(db) {
  let state = states.get(db);
  if (!state) {
    state = { controller: new MockLightingController(), tuyaClient: null, driver: "mock" };
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

  // Строка стола: по ней общий контроллер понимает, куда слать команду.
  const resolveRow = (tableId) =>
    db
      .prepare(
        `SELECT tuya_device_id, tuya_switch_code,
                light_kind, light_host, light_channel, light_on_url, light_off_url
         FROM tables WHERE id = ?`
      )
      .get(tableId) ?? null;

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
      tuya = new TuyaLightingController(state.tuyaClient, (tableId) => {
        const row = resolveRow(tableId);
        return row
          ? { device_id: row.tuya_device_id, switch_code: row.tuya_switch_code }
          : null;
      });
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
