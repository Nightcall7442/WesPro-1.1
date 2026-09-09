// Точка входа. Запуск: npm run dev (перезапуск при изменении файлов)
// или npm start.

import { createApp } from "./app.js";
import { PORT, SEED_INITIAL_DATA } from "./config.js";
import { createDatabase } from "./db.js";
import { seedInitialData } from "./seed.js";
import { startAutoBackup } from "./services/auto-backup.js";
import { startBookingReminders } from "./services/telegram.js";
import { initLighting, syncLighting } from "./services/lighting.js";
import { lanAddresses } from "./services/network.js";

const db = createDatabase();
if (SEED_INITIAL_DATA) {
  seedInitialData(db);
}
await initLighting(db);
// Свет мог остаться включённым после аварийного выключения программы —
// приводим его в соответствие с открытыми сеансами.
await syncLighting(db).catch(() => {});
// Ежедневная копия базы в папку backups: страховка от «полетел компьютер».
startAutoBackup(db);
// Напоминания о бронях в Telegram (если бот настроен в «Настройках»).
startBookingReminders(db);

const app = createApp(db);
// Без указания адреса Express слушает все сетевые интерфейсы сразу:
// зайти можно и с самого компьютера, и с любого устройства сети по
// любому из адресов ниже.
app.listen(PORT, () => {
  console.log(`Бильярдный клуб: http://127.0.0.1:${PORT}`);

  const addresses = lanAddresses();
  if (!addresses.length) {
    console.log(
      "   Адрес в локальной сети не найден: проверьте, что компьютер\n" +
        "   подключён к Wi-Fi или кабелю."
    );
    return;
  }
  console.log("   С телефона, планшета и ноутбука в той же сети:");
  for (const { address, iface, virtual } of addresses) {
    const note = virtual
      ? "  (виртуальная сеть программы — с телефона не откроется)"
      : "";
    console.log(`     http://${address}:${PORT}   — ${iface}${note}`);
  }
  if (addresses.length > 1) {
    console.log(
      "   Если адресов несколько, подходит тот, у которого первые три\n" +
        "   числа совпадают с адресом телефона (Wi-Fi → сведения о сети)."
    );
  }
});
