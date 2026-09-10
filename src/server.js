// Точка входа. Запуск: npm run dev (перезапуск при изменении файлов)
// или npm start.

import { createApp } from "./app.js";
import { CLUBS_DIR, networkMode, PORT, SEED_INITIAL_DATA } from "./config.js";
import { createDatabase } from "./db.js";
import { seedHubOwner } from "./hub/auth.js";
import { createHubDatabase } from "./hub/db.js";
import { createNetworkApp } from "./network-app.js";
import { seedInitialData } from "./seed.js";
import { startAutoBackup } from "./services/auto-backup.js";
import { startBookingReminders } from "./services/telegram.js";
import { initLighting, syncLighting } from "./services/lighting.js";
import { lanAddresses } from "./services/network.js";

// Центральная панель сети клубов: своя база, свой раздел /hub.
const hubDb = createHubDatabase();
const hubOwner = seedHubOwner(hubDb);

let app;
if (networkMode()) {
  // Сеть клубов: базы заводятся по мере того, как клубы заходят, а
  // фоновые задачи ниже не запускаются — свет в зале из облака всё
  // равно не переключить, а копии баз и напоминания в этом режиме
  // делаются иначе (см. пункт «офлайн-режим с синхронизацией»).
  app = createNetworkApp(hubDb);
} else {
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
  app = createApp(db, hubDb);
}

// Без указания адреса Express слушает все сетевые интерфейсы сразу:
// зайти можно и с самого компьютера, и с любого устройства сети по
// любому из адресов ниже.
app.listen(PORT, () => {
  // Режим печатаем первым делом: по логам хостинга сразу видно, включена
  // ли переменная WESPRO_NETWORK — без этого «почему вход не открывает
  // программу» приходится выяснять вслепую.
  console.log(
    networkMode()
      ? `Режим: сеть клубов — у каждого своя база в ${CLUBS_DIR}`
      : "Режим: один клуб (сеть выключена, WESPRO_NETWORK не задана)"
  );
  console.log(`Бильярдный клуб: http://127.0.0.1:${PORT}`);
  console.log(`Панель сети клубов: http://127.0.0.1:${PORT}/hub`);
  if (hubOwner) {
    console.log(
      `   Вход в панель — логин «${hubOwner.login}», пароль «${hubOwner.password}»` +
        (hubOwner.generated ? " (сгенерирован, смените после входа)" : "")
    );
    if (hubOwner.reset) {
      console.log(
        "   Пароль задан переменной WESPRO_HUB_PASSWORD и будет ставиться\n" +
          "   заново при каждом запуске. Войдите, смените пароль в панели\n" +
          "   и уберите переменную — иначе смена не удержится."
      );
    }
  }

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
