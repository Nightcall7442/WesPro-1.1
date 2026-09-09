// Печатает адреса, по которым клуб открывается с других устройств.
// Вызывается из start-club.bat: так список адресов в окне запуска и в
// консоли сервера считается одним и тем же кодом, без дублирования
// логики на PowerShell (где ещё и экранирование в .bat-файле ломается).

import { PORT } from "./config.js";
import { lanAddresses } from "./services/network.js";

const addresses = lanAddresses();

if (!addresses.length) {
  console.log("   Адрес в локальной сети не найден.");
  console.log("   Проверьте, что компьютер подключён к Wi-Fi или кабелю.");
} else {
  for (const { address, iface, virtual } of addresses) {
    const url = `http://${address}:${PORT}`;
    const note = virtual ? "  (виртуальная сеть, с телефона не откроется)" : "";
    console.log(`   ${url.padEnd(24)} -- ${iface}${note}`);
  }
}
