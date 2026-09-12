// Реле, которыми управляют по локальной сети, без облака.
//
// Tuya/MOES работают через интернет и аккаунт разработчика Tuya: если
// интернет пропал — свет не переключить. Поэтому кроме них поддержаны
// три «домашних» варианта, каждый из которых слушается обычного
// HTTP-запроса в локальной сети:
//
//   tasmota — прошивка Tasmota (Sonoff, Blitzwolf, многие MOES после
//             перепрошивки): /cm?cmnd=Power1%20On
//   shelly  — реле Shelly. Gen1: /relay/0?turn=on
//             Gen2 (Plus/Pro): /rpc/Switch.Set?id=0&on=true
//             Поколение определяется само и запоминается.
//   url     — «своё устройство»: два адреса, включить и выключить.
//             Подходит ко всему, что умеет HTTP: ESPHome, Home Assistant,
//             самодельные реле на ESP.
//
// Общее правило: касса не должна зависеть от железа. Ошибка реле не
// мешает открыть или закрыть стол — она уходит в журнал ошибок.

import { logServerError } from "./diagnostics.js";

/** Типы устройств, которыми управляем по HTTP. */
export const HTTP_KINDS = ["tasmota", "shelly", "url"];

/** Сколько ждём ответ реле: оно в той же сети, дольше секунды — уже беда. */
const TIMEOUT_MS = 4000;

/** Какое поколение Shelly отвечает по этому адресу (узнаём один раз). */
const shellyGeneration = new Map();

function normalizeHost(host) {
  const text = String(host ?? "").trim().replace(/\/+$/, "");
  if (!text) return null;
  return /^https?:\/\//i.test(text) ? text : `http://${text}`;
}

async function request(url) {
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json, text/plain, */*" },
    });
  } catch (error) {
    // Своими словами, а не «The operation was aborted due to timeout».
    if (error.name === "TimeoutError") throw new Error("реле не отвечает по сети");
    throw new Error(`реле недоступно: ${error.cause?.message ?? error.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`устройство ответило ${response.status}: ${text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text; // Tasmota иногда отвечает простым текстом
  }
}

/** Tasmota: каналы нумеруются с единицы (Power1, Power2 …). */
function tasmotaUrls(host, channel) {
  const n = Number(channel ?? 0) + 1;
  return {
    on: `${host}/cm?cmnd=Power${n}%20On`,
    off: `${host}/cm?cmnd=Power${n}%20Off`,
    status: `${host}/cm?cmnd=Power${n}`,
  };
}

function tasmotaStateOf(data, channel) {
  if (!data || typeof data !== "object") {
    return typeof data === "string" ? /on/i.test(data) : null;
  }
  const n = Number(channel ?? 0) + 1;
  const value = data[`POWER${n}`] ?? data.POWER ?? data[`Power${n}`] ?? data.Power;
  if (value === undefined) return null;
  return String(value).toUpperCase() === "ON";
}

/**
 * Положение привода (заслонка, штора) в процентах. Tasmota — прошивка с
 * шторами (ShutterPosition), Shelly — режим roller/cover, «своё
 * устройство» — адрес включения с подстановкой {percent}.
 */
function positionUrl(device, percent) {
  if (device.kind === "url") {
    const template = String(device.on_url ?? "").trim();
    if (!template.includes("{percent}")) {
      throw new Error("В адресе включения нет {percent} — некуда подставить положение");
    }
    return template.replaceAll("{percent}", String(percent));
  }
  const host = normalizeHost(device.host);
  if (!host) throw new Error("Не задан адрес устройства (IP в локальной сети)");
  const n = Number(device.channel ?? 0);
  if (device.kind === "tasmota") return `${host}/cm?cmnd=ShutterPosition${n + 1}%20${percent}`;
  return (shellyGeneration.get(host) ?? 1) === 2
    ? `${host}/rpc/Cover.GoToPosition?id=${n}&pos=${percent}`
    : `${host}/roller/${n}?go=to_pos&roller_pos=${percent}`;
}

/** Shelly: у Gen1 и Gen2 разные адреса — пробуем то, что уже сработало. */
function shellyUrls(host, channel, generation) {
  const id = Number(channel ?? 0);
  if (generation === 2) {
    return {
      on: `${host}/rpc/Switch.Set?id=${id}&on=true`,
      off: `${host}/rpc/Switch.Set?id=${id}&on=false`,
      status: `${host}/rpc/Switch.GetStatus?id=${id}`,
    };
  }
  return {
    on: `${host}/relay/${id}?turn=on`,
    off: `${host}/relay/${id}?turn=off`,
    status: `${host}/relay/${id}`,
  };
}

function shellyStateOf(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.ison === "boolean") return data.ison; // Gen1
  if (typeof data.output === "boolean") return data.output; // Gen2
  return null;
}

/**
 * Управление реле по HTTP. Какое устройство у какого стола — решает
 * resolveDevice: привязка хранится в базе и настраивается в интерфейсе.
 */
export class HttpLightingController {
  #resolveDevice;
  #on = new Set();

  /**
   * @param {(tableId: number) => ({kind: string, host?: string,
   *   channel?: number, on_url?: string, off_url?: string} | null)} resolveDevice
   */
  constructor(resolveDevice) {
    this.#resolveDevice = resolveDevice;
  }

  /** Умеет ли этот контроллер обслуживать стол. */
  handles(tableId) {
    const device = this.#resolveDevice(tableId);
    return Boolean(device && HTTP_KINDS.includes(device.kind));
  }

  /** Адреса устройства для включения/выключения/опроса. */
  #urlsFor(device) {
    if (device.kind === "url") {
      const on = String(device.on_url ?? "").trim();
      const off = String(device.off_url ?? "").trim();
      if (!on || !off) {
        throw new Error("Не заданы адреса включения и выключения");
      }
      return { on, off, status: null };
    }
    const host = normalizeHost(device.host);
    if (!host) throw new Error("Не задан адрес устройства (IP в локальной сети)");
    if (device.kind === "tasmota") return tasmotaUrls(host, device.channel);
    return shellyUrls(host, device.channel, shellyGeneration.get(host) ?? 1);
  }

  /**
   * Включает или выключает свет и ждёт ответа устройства.
   * @param {number} tableId @param {boolean} value
   */
  async setLight(tableId, value) {
    const device = this.#resolveDevice(tableId);
    if (!device) throw new Error("Стол не привязан к устройству");
    const urls = this.#urlsFor(device);
    try {
      await request(value ? urls.on : urls.off);
    } catch (error) {
      // Shelly второго поколения не знает адресов первого — пробуем ещё раз.
      if (device.kind === "shelly") {
        const host = normalizeHost(device.host);
        const other = (shellyGeneration.get(host) ?? 1) === 1 ? 2 : 1;
        const retry = shellyUrls(host, device.channel, other);
        await request(value ? retry.on : retry.off);
        shellyGeneration.set(host, other); // запомнили поколение
      } else {
        throw error;
      }
    }
    if (value) this.#on.add(tableId);
    else this.#on.delete(tableId);
    return true;
  }

  /**
   * Отвечает ли реле по сети. «Своё устройство» опросить нечем — null.
   * @returns {Promise<boolean|null>}
   */
  async isOnline(id) {
    const device = this.#resolveDevice(id);
    if (!device || device.kind === "url") return null;
    return (await this.readLight(id)) !== null;
  }

  /**
   * Ставит привод в положение (проценты) и ждёт ответа.
   * @param {number} id @param {number} percent
   */
  async setPosition(id, percent) {
    const device = this.#resolveDevice(id);
    if (!device) throw new Error("Устройство не привязано к приводу");
    try {
      await request(positionUrl(device, percent));
    } catch (error) {
      // Как и у выключателя: Shelly другого поколения — пробуем ещё раз.
      if (device.kind !== "shelly") throw error;
      const host = normalizeHost(device.host);
      const other = (shellyGeneration.get(host) ?? 1) === 1 ? 2 : 1;
      shellyGeneration.set(host, other);
      try {
        await request(positionUrl(device, percent));
      } catch (retryError) {
        shellyGeneration.delete(host);
        throw retryError;
      }
    }
    return true;
  }

  /**
   * Спрашивает у реле, горит ли свет на самом деле.
   * @returns {Promise<boolean|null>} null — узнать не удалось
   */
  async readLight(tableId) {
    const device = this.#resolveDevice(tableId);
    if (!device) return null;
    let urls;
    try {
      urls = this.#urlsFor(device);
    } catch {
      return null;
    }
    if (!urls.status) return null; // «своё устройство» опросить нечем
    try {
      const data = await request(urls.status);
      const state =
        device.kind === "tasmota"
          ? tasmotaStateOf(data, device.channel)
          : shellyStateOf(data);
      if (state === null) return null;
      if (state) this.#on.add(tableId);
      else this.#on.delete(tableId);
      return state;
    } catch {
      return null; // реле недоступно — касса от этого не зависит
    }
  }

  /** Включение при открытии сеанса: не ждём ответа, ошибку пишем в журнал. */
  turnLightOn(tableId) {
    this.#on.add(tableId);
    this.setLight(tableId, true).catch((error) =>
      logServerError(new Error(`Свет над столом ${tableId}: ${error.message}`))
    );
  }

  turnLightOff(tableId) {
    this.#on.delete(tableId);
    this.setLight(tableId, false).catch((error) =>
      logServerError(new Error(`Свет над столом ${tableId}: ${error.message}`))
    );
  }

  isLightOn(tableId) {
    return this.#on.has(tableId);
  }
}

/** Сброс запомненных поколений Shelly — нужен в тестах. */
export function forgetShellyGenerations() {
  shellyGeneration.clear();
}
