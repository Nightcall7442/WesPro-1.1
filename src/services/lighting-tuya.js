// Драйвер освещения для реле экосистемы Tuya (MOES WM4LT1 и совместимые).
//
// Управление идёт через официальный Tuya Cloud API: на открытие сеанса
// устройству уходит команда {code: "switch_1", value: true}, на закрытие —
// value: false. Команды отправляются асинхронно и не блокируют кассовые
// операции: если облако недоступно, сеанс всё равно откроется/закроется,
// а ошибка попадёт в лог сервера.
//
// Какое реле у какого стола — решает resolveDevice: привязка хранится
// в базе и настраивается во вкладке «Настройки», без правки кода.

export const DEFAULT_SWITCH_CODE = "switch_1";
/** Код положения у приводов Tuya (заслонки, шторы, клапаны): 0–100 %. */
export const POSITION_CODE = "percent_control";

/**
 * @typedef {Object} TuyaDevice
 * @property {string} device_id  ID устройства из Tuya IoT Platform
 * @property {string} [switch_code] код канала реле (по умолчанию switch_1)
 */

export class TuyaLightingController {
  #client;
  #resolveDevice;
  #on = new Set();

  /**
   * @param {{request: Function}} client TuyaContext из @tuya/tuya-connector-nodejs
   *   (в тестах — совместимая заглушка)
   * @param {(tableId: number) => TuyaDevice | null} resolveDevice привязка
   *   стола к устройству (обычно чтение из базы)
   */
  constructor(client, resolveDevice) {
    this.#client = client;
    this.#resolveDevice = resolveDevice;
  }

  /**
   * Отправляет команду и ждёт ответа. Нужна для ручного включения из
   * интерфейса: там кассир должен увидеть, получилось или нет.
   * @param {number} tableId
   * @param {boolean} value
   */
  async setLight(tableId, value) {
    const device = this.#resolveDevice(tableId);
    if (!device?.device_id) {
      throw new Error(
        "Стол не привязан к реле — выберите устройство в «Настройках»"
      );
    }
    const code = device.switch_code || DEFAULT_SWITCH_CODE;
    const response = await this.#client.request({
      method: "POST",
      path: `/v1.0/iot-03/devices/${device.device_id}/commands`,
      body: { commands: [{ code, value }] },
    });
    if (!response?.success) {
      throw new Error(
        `Реле не приняло команду: ${response?.msg ?? response?.code ?? "нет ответа"}`
      );
    }
    if (value) this.#on.add(tableId);
    else this.#on.delete(tableId);
    return true;
  }

  /**
   * Опрос устройства по данным облака: в сети ли (там видно, что реле
   * отвалилось от Wi-Fi) и с какого адреса выходит. MAC облако не
   * отдаёт — его вписывают руками.
   * @param {number} id
   * @returns {Promise<{online: boolean|null, ip?: string}>}
   */
  async probe(id) {
    const device = this.#resolveDevice(id);
    if (!device?.device_id) return { online: null };
    try {
      const response = await this.#client.request({
        method: "GET",
        path: `/v1.0/iot-03/devices/${device.device_id}`,
      });
      if (!response?.success) return { online: null };
      const { online, ip } = response.result ?? {};
      return {
        online: typeof online === "boolean" ? online : null,
        ip: typeof ip === "string" && ip ? ip : undefined,
      };
    } catch {
      return { online: null };
    }
  }

  /**
   * Положение привода в процентах (решётка канала на моторе Tuya).
   * Ждёт ответа, как и setLight: кассир должен видеть, приняла ли
   * заслонка команду.
   * @param {number} id @param {number} percent
   */
  async setPosition(id, percent) {
    const device = this.#resolveDevice(id);
    if (!device?.device_id) {
      throw new Error("Устройство не привязано к приводу — выберите его в настройках");
    }
    const response = await this.#client.request({
      method: "POST",
      path: `/v1.0/iot-03/devices/${device.device_id}/commands`,
      body: { commands: [{ code: POSITION_CODE, value: percent }] },
    });
    if (!response?.success) {
      throw new Error(
        `Привод не принял положение: ${response?.msg ?? response?.code ?? "нет ответа"}`
      );
    }
    return true;
  }

  /**
   * Спрашивает у реле, горит ли свет на самом деле. Своя память врёт
   * после перезапуска программы и когда свет щёлкнули руками на стене —
   * поэтому состояние периодически сверяется с устройством.
   * @param {number} tableId
   * @returns {Promise<boolean|null>} null — узнать не удалось
   */
  async readLight(tableId) {
    const device = this.#resolveDevice(tableId);
    if (!device?.device_id) return null;
    const code = device.switch_code || DEFAULT_SWITCH_CODE;
    try {
      const response = await this.#client.request({
        method: "GET",
        path: `/v1.0/iot-03/devices/${device.device_id}/status`,
      });
      if (!response?.success) return null;
      const row = (response.result ?? []).find((r) => r.code === code);
      if (typeof row?.value !== "boolean") return null;
      if (row.value) this.#on.add(tableId);
      else this.#on.delete(tableId);
      return row.value;
    } catch {
      return null; // облако недоступно — молчим, касса от этого не зависит
    }
  }

  /** @param {number} tableId @param {boolean} value */
  #send(tableId, value) {
    const device = this.#resolveDevice(tableId);
    if (!device?.device_id) {
      console.warn(
        `Tuya lighting: стол ${tableId} не привязан к устройству — команда пропущена`
      );
      return;
    }
    const code = device.switch_code || DEFAULT_SWITCH_CODE;
    this.#client
      .request({
        method: "POST",
        path: `/v1.0/iot-03/devices/${device.device_id}/commands`,
        body: { commands: [{ code, value }] },
      })
      .then((response) => {
        if (!response?.success) {
          console.error(
            `Tuya lighting: устройство ${device.device_id} отклонило команду ` +
              `${code}=${value}: ${JSON.stringify(response)}`
          );
        }
      })
      .catch((error) => {
        console.error(
          `Tuya lighting: не удалось отправить ${code}=${value} ` +
            `устройству ${device.device_id}: ${error.message}`
        );
      });
  }

  /** @param {number} tableId */
  turnLightOn(tableId) {
    this.#on.add(tableId);
    this.#send(tableId, true);
  }

  /** @param {number} tableId */
  turnLightOff(tableId) {
    this.#on.delete(tableId);
    this.#send(tableId, false);
  }

  /** @param {number} tableId */
  isLightOn(tableId) {
    return this.#on.has(tableId);
  }
}
