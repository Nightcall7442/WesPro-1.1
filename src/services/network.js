// Адреса, по которым клуб открывается с других устройств в той же сети.
//
// Сервер слушает все сетевые интерфейсы сразу (app.listen без host), то
// есть заходить можно по любому из этих адресов. Сложность в другом: у
// компьютера их обычно несколько (кабель, Wi-Fi, а ещё виртуальные
// адаптеры от VirtualBox/Hyper-V/WSL), и телефон видит только тот, что в
// его подсети. Поэтому адреса нужно показывать все и с подсказками, а не
// один первый попавшийся.

import os from "node:os";

// Имена адаптеров, которые почти наверняка не ведут в домашнюю сеть:
// это виртуальные сети программ, к ним телефон не подключён.
const VIRTUAL_HINTS = [
  "virtualbox",
  "vmware",
  "hyper-v",
  "vethernet",
  "wsl",
  "docker",
  "loopback",
  "tailscale",
  "zerotier",
  "radmin",
  "hamachi",
  "tap-windows",
  "openvpn",
  "bluetooth",
];

function looksVirtual(name) {
  const lower = name.toLowerCase();
  return VIRTUAL_HINTS.some((hint) => lower.includes(hint));
}

/** Первые три числа адреса — «подсеть» на языке пользователя (192.168.1). */
export function subnetPrefix(address) {
  return address.split(".").slice(0, 3).join(".");
}

/**
 * Адреса компьютера в локальных сетях (IPv4, без 127.0.0.1).
 * Сначала обычные адаптеры, потом виртуальные — чтобы первый в списке был
 * тем, который чаще всего и нужен.
 * @returns {Array<{address: string, iface: string, netmask: string, virtual: boolean}>}
 */
export function lanAddresses() {
  const result = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (!info || info.family !== "IPv4" || info.internal) continue;
      result.push({
        address: info.address,
        iface,
        netmask: info.netmask,
        virtual: looksVirtual(iface),
      });
    }
  }
  result.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return result;
}

/**
 * Всё, что нужно показать в настройках: порт, имя компьютера и адреса
 * с готовыми ссылками.
 * @param {number} port
 */
export function networkInfo(port) {
  return {
    port,
    hostname: os.hostname(),
    addresses: lanAddresses().map((item) => ({
      ...item,
      url: `http://${item.address}:${port}`,
      subnet: subnetPrefix(item.address),
    })),
  };
}
