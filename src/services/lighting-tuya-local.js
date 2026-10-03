// Реле Tuya/MOES по локальной сети — без облака Tuya.
//
// У каждого Tuya-реле (MOES, Avatto, Aubess и т. д.) есть локальный
// протокол: устройство слушает TCP-порт 6668 в сети клуба и принимает
// команды напрямую. Интернет и аккаунт iot.tuya.com для этого не нужны —
// нужен только «локальный ключ» устройства (local_key, 16 символов):
// им шифруется каждая команда. Ключ узнают один раз (см. README) и
// вписывают в «Настройки»; он меняется, только если реле заново
// спарить в приложении Smart Life.
//
// Протокол реализует библиотека tuyapi (версии 3.1, 3.3, 3.4, 3.5).
// Какая версия у реле — видно при поиске в сети; если не указана, пробуем
// по очереди и запоминаем ту, что ответила (как поколение у Shelly).
//
// Реле держит одно соединение за раз, поэтому на каждую команду
// подключаемся, делаем дело и отключаемся, а команды к одному реле идут
// строго по очереди. Касса от реле не зависит: ошибка автоматического
// включения уходит в журнал ошибок, а не мешает открыть стол.

import crypto from "node:crypto";
import dgram from "node:dgram";

import TuyAPI from "tuyapi";
import { MessageParser } from "tuyapi/lib/message-parser.js";

import { logServerError } from "./diagnostics.js";

/** Версии протокола; в таком порядке пробуем, если версия не указана. */
export const TUYA_LOCAL_VERSIONS = ["3.3", "3.4", "3.5", "3.1"];

/** Сколько ждём одну попытку: реле в той же сети, дольше — уже беда. */
const TIMEOUT_MS = 4000;

/**
 * Порты, на которые Tuya-устройства раз в несколько секунд сообщают о себе:
 * 6666 — протокол 3.1 открытым текстом, 6667 — 3.3/3.4, 7000 — 3.5.
 */
export const DISCOVERY_PORTS = [6666, 6667, 7000];

/** Ключ, которым зашифрованы эти сообщения, — общий для всех устройств Tuya. */
const UDP_KEY = crypto.createHash("md5").update("yGAdlopoPVldABfn", "utf8").digest();

/** Какая версия протокола ответила по этому адресу (узнаём один раз). */
const knownVersions = new Map();

/** Канал реле switch_1 … switch_4 → номер DP в протоколе (1 … 4). */
function dpsOf(switchCode) {
  const match = /^switch_([1-4])$/.exec(String(switchCode ?? ""));
  return match ? Number(match[1]) : 1;
}

/** Своими словами, а не «Timeout waiting for status response from device id». */
function explain(error) {
  const message = String(error?.message ?? error ?? "");
  if (/ECONNREFUSED/i.test(message)) {
    return new Error(
      "реле отклонило подключение — возможно, его держит приложение Smart Life на телефоне"
    );
  }
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|unreachable/i.test(message)) {
    return new Error("реле недоступно по сети — проверьте IP-адрес и что компьютер в той же сети");
  }
  if (/HMAC mismatch|bad key/i.test(message)) {
    return new Error("реле ответило, но не приняло ключ — проверьте локальный ключ и версию протокола");
  }
  return new Error(
    "реле не отвечает — проверьте IP-адрес, локальный ключ и версию протокола"
  );
}

/**
 * Ответ реле, расшифрованный не тем ключом, приходит строкой-мусором, и
 * tuyapi отдаёт её как есть. Настоящий ответ — объект (или пусто).
 */
function checkAnswer(answer) {
  if (typeof answer === "string") throw new Error("bad key");
  return answer;
}

/** Обещание с ограничением по времени; onTimeout прибирает за собой. */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error("timeout"));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Клиент протокола по умолчанию — tuyapi; в тестах подставляют свой. */
function defaultCreateClient({ id, key, ip, version }) {
  return new TuyAPI({ id, key, ip, version, issueGetOnConnect: false });
}

/**
 * @typedef {Object} TuyaLocalDevice
 * @property {string} device_id  ID устройства (как в Smart Life / iot.tuya.com)
 * @property {string} local_key  локальный ключ, 16 символов
 * @property {string} host       IP реле в сети клуба
 * @property {string|null} [version] версия протокола; пусто — подобрать
 * @property {string|null} [switch_code] канал switch_1 … switch_4
 */

export class TuyaLocalLightingController {
  #resolveDevice;
  #createClient;
  #timeoutMs;
  #on = new Set();
  /** Очередь команд к каждому реле: одно соединение за раз. */
  #queues = new Map();

  /**
   * @param {(id: number) => TuyaLocalDevice | null} resolveDevice привязка
   *   стола (или устройства зала) к реле — обычно чтение из базы
   * @param {{createClient?: Function, timeoutMs?: number}} [options]
   */
  constructor(resolveDevice, { createClient = defaultCreateClient, timeoutMs = TIMEOUT_MS } = {}) {
    this.#resolveDevice = resolveDevice;
    this.#createClient = createClient;
    this.#timeoutMs = timeoutMs;
  }

  /** Привязка с проверкой: без id, ключа и адреса команду не отправить. */
  #deviceFor(id) {
    const device = this.#resolveDevice(id);
    if (!device?.device_id) throw new Error("Не задан ID устройства Tuya");
    if (!device.local_key) throw new Error("Не задан локальный ключ реле");
    if (!device.host) throw new Error("Не задан IP-адрес реле в локальной сети");
    return device;
  }

  /** Ставит работу в очередь этого реле. */
  #enqueue(device, job) {
    const key = `${device.host}|${device.device_id}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(job);
    this.#queues.set(key, next);
    next
      .catch(() => {})
      .finally(() => {
        if (this.#queues.get(key) === next) this.#queues.delete(key);
      });
    return next;
  }

  /**
   * Одна попытка: подключиться указанной версией протокола, выполнить
   * work(client) и отключиться. Не уложились во время — рвём соединение
   * сами: иначе tuyapi ещё долго пытается переподключиться в фоне.
   */
  async #attempt(device, version, work) {
    const client = this.#createClient({
      id: device.device_id,
      key: device.local_key,
      ip: device.host,
      version,
    });
    // tuyapi сообщает о сбоях событием error; без слушателя Node уронил
    // бы весь процесс. Сами ошибки приходят и через отказ обещания.
    client.on?.("error", () => {});
    let abandoned = false;
    let timedOut = false;
    // Дошло ли дело до TCP-соединения и не оборвало ли его само реле.
    // Не дошло — реле нет по этому адресу, и другая версия протокола тут
    // не поможет. Дошло, а реле оборвало — так реле 3.4/3.5 отвечает на
    // команду, зашифрованную не тем ключом.
    let tcpConnected = false;
    let closedByDevice = false;
    const cleanup = () => {
      abandoned = true;
      // Брошенный клиент больше не переподключается сам.
      client.connect = () => Promise.reject(new Error("соединение закрыто"));
      try {
        client.disconnect?.();
      } catch {
        // уже отключено
      }
      client.client?.destroy?.();
    };
    try {
      return await withTimeout(
        (async () => {
          const connecting = client.connect();
          // Сокет tuyapi создаёт внутри connect() сразу — успеваем подписаться.
          client.client?.once?.("connect", () => {
            tcpConnected = true;
          });
          client.client?.once?.("close", () => {
            if (!abandoned) closedByDevice = true;
          });
          await connecting;
          if (abandoned) throw new Error("timeout");
          return await work(client);
        })(),
        this.#timeoutMs,
        () => {
          timedOut = true;
          cleanup();
        }
      );
    } catch (error) {
      if (timedOut && client.client && !tcpConnected) throw new Error("unreachable");
      if (tcpConnected && closedByDevice) throw new Error("bad key: соединение оборвало реле");
      throw error;
    } finally {
      if (!abandoned) cleanup();
    }
  }

  /**
   * Выполняет work на реле: указанной версией, а если версия не указана —
   * запомненной или по очереди всеми, пока какая-то не ответит.
   */
  #run(id, work) {
    const device = this.#deviceFor(id);
    return this.#enqueue(device, async () => {
      const memoKey = `${device.host}|${device.device_id}`;
      const remembered = knownVersions.get(memoKey);
      const versions = device.version
        ? [device.version]
        : [...new Set([remembered, ...TUYA_LOCAL_VERSIONS].filter(Boolean))];
      let lastError;
      for (const version of versions) {
        try {
          const result = await this.#attempt(device, version, work);
          knownVersions.set(memoKey, version);
          return result;
        } catch (error) {
          lastError = error;
          // Реле на месте, но отказало, — другая версия не поможет.
          if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|unreachable/i.test(String(error?.message))) break;
          // Нечитаемый ответ бывает и от чужого ключа, и от чужой версии
          // протокола, — поэтому пробуем следующую версию.
        }
      }
      if (remembered && !device.version) knownVersions.delete(memoKey);
      throw explain(lastError);
    });
  }

  /**
   * Включает или выключает реле и ждёт ответа: при ручном управлении
   * кассир должен видеть, получилось или нет.
   * @param {number} id @param {boolean} value
   */
  async setLight(id, value) {
    const dps = dpsOf(this.#resolveDevice(id)?.switch_code);
    await this.#run(id, async (client) => checkAnswer(await client.set({ dps, set: Boolean(value) })));
    if (value) this.#on.add(id);
    else this.#on.delete(id);
    return true;
  }

  /**
   * Спрашивает у реле, включено ли оно на самом деле.
   * @returns {Promise<boolean|null>} null — узнать не удалось
   */
  async readLight(id) {
    try {
      const dps = dpsOf(this.#resolveDevice(id)?.switch_code);
      const value = await this.#run(id, (client) => client.get({ dps }));
      if (typeof value !== "boolean") return null;
      if (value) this.#on.add(id);
      else this.#on.delete(id);
      return value;
    } catch {
      return null; // реле недоступно — касса от этого не зависит
    }
  }

  /**
   * Опрос: отвечает ли реле. IP — тот, по которому достучались; MAC
   * локальный протокол не сообщает — его вписывают руками.
   * @returns {Promise<{online: boolean|null, ip?: string}>}
   */
  async probe(id) {
    let device;
    try {
      device = this.#deviceFor(id);
    } catch {
      return { online: null };
    }
    try {
      // Ответило, но ключ не тот — для программы это всё равно «нет связи»:
      // командовать таким реле нельзя.
      await this.#run(id, async (client) => checkAnswer(await client.get({ schema: true })));
      return { online: true, ip: device.host };
    } catch {
      return { online: false };
    }
  }

  /** Приводы (решётки на моторе) по локальной сети пока не поддержаны. */
  async setPosition() {
    throw new Error(
      "Положение решётки через Tuya по локальной сети пока не поддерживается — " +
        "подключите привод через облако Tuya или Tasmota/Shelly"
    );
  }

  /** Включение при открытии сеанса: не ждём ответа, ошибку пишем в журнал. */
  turnLightOn(id) {
    this.#on.add(id);
    this.setLight(id, true).catch((error) =>
      logServerError(new Error(`Свет над столом ${id}: ${error.message}`))
    );
  }

  turnLightOff(id) {
    this.#on.delete(id);
    this.setLight(id, false).catch((error) =>
      logServerError(new Error(`Свет над столом ${id}: ${error.message}`))
    );
  }

  isLightOn(id) {
    return this.#on.has(id);
  }
}

// Слушатели широковещательных сообщений Tuya — по одному на набор портов.
// На них подписываются и поиск из «Настроек», и постоянное слежение за
// адресами реле (lighting.js): второй раз занимать те же порты незачем,
// да и не везде два сокета на одном порту получат по копии пакета.
const listeners = new Map();

/** Разбирает сообщение реле о себе; null — не Tuya или повреждено. */
function parseAnnouncement(parser, message, rinfo) {
  let payload;
  try {
    payload = parser.parse(message)[0]?.payload;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !payload.gwId) return null;
  return {
    id: String(payload.gwId),
    ip: String(payload.ip ?? rinfo.address),
    version: payload.version ? String(payload.version) : null,
    product_key: payload.productKey ? String(payload.productKey) : null,
  };
}

/**
 * Подписка на сообщения Tuya-реле о себе: onDevice({id, ip, version,
 * product_key}) зовётся на каждое (реле повторяют их раз в несколько
 * секунд). Порты открываются при первой подписке и закрываются с
 * последней отпиской.
 *
 * По Wi-Fi часть сообщений теряется, поэтому слушатель помнит, кто
 * отзывался недавно: с replayMs новый подписчик сразу получает реле,
 * слышанные за это время (пока программа слушает сеть постоянно, поиск
 * в «Настройках» находит реле мгновенно).
 *
 * @param {(device: {id: string, ip: string, version: string|null,
 *   product_key: string|null}) => void} onDevice
 * @param {{ports?: number[], replayMs?: number}} [options]
 * @returns {Promise<() => void>} отписка
 * @throws если не удалось занять ни одного порта
 */
export async function subscribeTuyaAnnouncements(
  onDevice,
  { ports = DISCOVERY_PORTS, replayMs = 0 } = {}
) {
  const key = ports.join(",");
  let listener = listeners.get(key);
  if (!listener) {
    const subscribers = new Set();
    const recent = new Map();
    const parser = new MessageParser({ key: UDP_KEY, version: "3.3" });
    const onMessage = (message, rinfo) => {
      const device = parseAnnouncement(parser, message, rinfo);
      if (!device) return;
      recent.set(device.id, { device, seenAt: Date.now() });
      for (const subscriber of subscribers) {
        try {
          subscriber(device);
        } catch {
          // ошибка одного подписчика не мешает остальным
        }
      }
    };
    const sockets = [];
    const errors = [];
    listener = {
      subscribers,
      recent,
      sockets,
      ready: Promise.all(
        ports.map(
          (port) =>
            new Promise((resolve) => {
              const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
              socket.on("message", onMessage);
              socket.once("error", (error) => {
                errors.push(`${port}: ${error.message}`);
                socket.close();
                resolve();
              });
              socket.bind(port, () => {
                socket.unref(); // слушатель не должен мешать программе закрыться
                sockets.push(socket);
                resolve();
              });
            })
        )
      ).then(() => {
        if (!sockets.length) {
          throw new Error(`Не удалось слушать порты поиска (${errors.join("; ")})`);
        }
      }),
    };
    listeners.set(key, listener);
  }
  try {
    await listener.ready;
  } catch (error) {
    if (listeners.get(key) === listener) listeners.delete(key);
    throw error;
  }
  listener.subscribers.add(onDevice);
  for (const { device, seenAt } of listener.recent.values()) {
    if (Date.now() - seenAt <= replayMs) onDevice(device);
  }
  return () => {
    listener.subscribers.delete(onDevice);
    if (listener.subscribers.size || listeners.get(key) !== listener) return;
    listeners.delete(key);
    for (const socket of listener.sockets) socket.close();
  };
}

/**
 * Реле, которые слушатель (если он запущен) слышал за последние maxAgeMs.
 * Без ожидания — для подсказок: какие реле сейчас в сети и по какому IP.
 * @param {number} [maxAgeMs]
 * @param {{ports?: number[]}} [options]
 */
export function recentTuyaAnnouncements(maxAgeMs = 60_000, { ports = DISCOVERY_PORTS } = {}) {
  const listener = listeners.get(ports.join(","));
  if (!listener) return [];
  return [...listener.recent.values()]
    .filter(({ seenAt }) => Date.now() - seenAt <= maxAgeMs)
    .map(({ device }) => device);
}

/**
 * Ищет Tuya-реле в локальной сети: слушает их широковещательные
 * сообщения и возвращает, кто отозвался. Так находятся ID, IP и версия
 * протокола — остаётся вписать только локальный ключ.
 *
 * На Windows входящие UDP на этих портах должен пропускать брандмауэр
 * (правило заводит start-club.bat).
 *
 * @param {{timeoutMs?: number, ports?: number[]}} [options]
 * @returns {Promise<Array<{id: string, ip: string, version: string|null,
 *   product_key: string|null}>>}
 */
export async function discoverTuyaDevices({ timeoutMs = 10_000, ports = DISCOVERY_PORTS } = {}) {
  const found = new Map();
  // Реле повторяют сообщение раз в ~5 секунд, но по Wi-Fi часть теряется:
  // ждём два-три повтора, а слышанных программой за минуту берём сразу.
  const unsubscribe = await subscribeTuyaAnnouncements(
    (device) => found.set(device.id, device),
    { ports, replayMs: 60_000 }
  );
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  unsubscribe();
  return [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, "en", { numeric: true }));
}

/** Сброс запомненных версий протокола — нужен в тестах. */
export function forgetTuyaLocalVersions() {
  knownVersions.clear();
}
