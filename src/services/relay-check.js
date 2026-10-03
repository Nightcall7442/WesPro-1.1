// Проверка реле с компьютера клуба: отвечает ли каждое по сети.
//
// Её печатает start-club.bat после запуска программы — чтобы «свет не
// включается» выяснялось сразу при запуске, а не вечером при гостях.
// Проверяется только то, что видно с этого компьютера: открыт ли у реле
// порт управления. Подсказки — по самым частым причинам: компьютер на
// Wi-Fi 5 ГГц (роутер не пропускает связь с реле на 2.4 ГГц) и реле в
// другой сети.

import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";

/** Порт управления по типу реле. Tasmota и Shelly — веб-интерфейс. */
const DEFAULT_PORTS = { tuya_local: 6668, tasmota: 80, shelly: 80 };

const KIND_LABELS = {
  tuya_local: "Tuya / MOES по сети",
  tasmota: "Tasmota",
  shelly: "Shelly",
};

/** Открывается ли TCP-соединение за отведённое время. */
function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Адрес и порт реле: у Tasmota/Shelly в адресе бывают http:// и :порт. */
function endpointOf(row, ports) {
  const text = String(row.light_host ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!text) return null;
  const match = /^(.+?)(?::(\d+))?$/.exec(text);
  return { host: match[1], port: match[2] ? Number(match[2]) : ports[row.light_kind] };
}

/** Реле в локальной сети, привязанные к столам и устройствам зала. */
function localRelays(db) {
  const kinds = Object.keys(DEFAULT_PORTS);
  const marks = kinds.map(() => "?").join(", ");
  const tables = db
    .prepare(
      `SELECT id, name, light_kind, light_host FROM tables
       WHERE is_active = 1 AND light_kind IN (${marks}) ORDER BY id`
    )
    .all(...kinds)
    .map((row) => ({ scope: "table", ...row }));
  const devices = db
    .prepare(`SELECT id, name, light_kind, light_host FROM devices WHERE light_kind IN (${marks}) ORDER BY id`)
    .all(...kinds)
    .map((row) => ({ scope: "device", ...row }));
  return [...tables, ...devices];
}

/**
 * Проверяет все локальные реле клуба.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{timeoutMs?: number, ports?: Record<string, number>}} [options]
 * @returns {Promise<Array<{scope: string, id: number, name: string, kind: string,
 *   label: string, host: string|null, ok: boolean}>>}
 */
export async function checkRelays(db, { timeoutMs = 2500, ports = DEFAULT_PORTS } = {}) {
  const relays = localRelays(db);
  return Promise.all(
    relays.map(async (row) => {
      const endpoint = endpointOf(row, ports);
      const ok = endpoint ? await tcpOpen(endpoint.host, endpoint.port, timeoutMs) : false;
      return {
        scope: row.scope,
        id: row.id,
        name: row.name,
        kind: row.light_kind,
        label: KIND_LABELS[row.light_kind] ?? row.light_kind,
        host: endpoint?.host ?? null,
        ok,
      };
    })
  );
}

/** IPv4-адреса этого компьютера (без виртуальных петель). */
function ownAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

/**
 * Реле не в той сети, что компьютер: первые три числа адреса не совпали
 * ни с одним адресом компьютера.
 * @param {string|null} host
 * @param {string[]} [own]
 */
export function otherSubnet(host, own = ownAddresses()) {
  if (!host || !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const prefix = host.split(".").slice(0, 3).join(".");
  return !own.some((address) => address.split(".").slice(0, 3).join(".") === prefix);
}

/**
 * Канал Wi-Fi, к которому подключён этот компьютер (Windows), или null.
 * Канал больше 14 — диапазон 5 ГГц. netsh пишет в кодировке консоли
 * (на русской Windows — 866), поэтому раскодируем сами.
 */
export function wifiChannel() {
  if (process.platform !== "win32") return null;
  try {
    const raw = execFileSync("netsh", ["wlan", "show", "interfaces"], { timeout: 4000 });
    let text;
    try {
      text = new TextDecoder("ibm866").decode(raw);
    } catch {
      text = raw.toString("latin1");
    }
    const match = /^\s*(?:Channel|Канал)\s*:\s*(\d+)\s*$/im.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null; // Wi-Fi нет или netsh недоступен — значит, кабель
  }
}
