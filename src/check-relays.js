// Печатает, какие реле клуба отвечают по сети. Вызывается из
// start-club.bat после запуска программы (и вручную: node src/check-relays.js).
//
// База открывается только на чтение: программа в это время уже работает
// с ней сама.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { DATABASE_PATH } from "./config.js";
import { checkRelays, otherSubnet, wifiChannel } from "./services/relay-check.js";

/** Сколько ждать перед повторной проверкой молчащих реле. */
const RETRY_MS = 10_000;

function read() {
  const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    return checkRelays(db);
  } finally {
    // checkRelays читает базу сразу, до первого await, — закрывать можно.
    db.close();
  }
}

async function main() {
  if (!fs.existsSync(DATABASE_PATH)) return;
  let results = await read();
  if (!results.length) {
    console.log("   Реле по локальной сети ещё не привязаны (Настройки - Привязка столов к реле).");
    return;
  }
  // Молчащее реле могло быть занято опросом программы или только что
  // сменить адрес (программа найдёт новый сама) — даём ему ещё попытку.
  if (results.some((r) => !r.ok)) {
    console.log("   Проверяем реле... (до 15 секунд)");
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    results = await read();
  }

  for (const r of results) {
    const where = `${r.label}, ${r.host ?? "адрес не указан"}`;
    console.log(`   ${r.ok ? "[OK]  " : "[НЕТ] "} ${r.name} -- ${where}${r.ok ? "" : " -- НЕ ОТВЕЧАЕТ"}`);
  }

  const silent = results.filter((r) => !r.ok);
  if (!silent.length) {
    console.log("   Все реле на связи.");
    return;
  }

  console.log("");
  const channel = wifiChannel();
  if (channel !== null && channel > 14) {
    console.log("   ! Компьютер подключён к Wi-Fi 5 ГГц. Реле работают на 2.4 ГГц, и роутер");
    console.log("     может не пропускать связь между ними. Подключите компьютер кабелем");
    console.log("     или к Wi-Fi 2.4 ГГц.");
  }
  for (const r of silent.filter((s) => otherSubnet(s.host))) {
    console.log(`   ! ${r.name}: адрес ${r.host} из другой сети, чем этот компьютер.`);
  }
  console.log("   Проверьте, что реле включено и в той же сети. Если роутер выдал реле");
  console.log("   новый адрес, программа найдёт его сама в течение минуты; проверить");
  console.log("   ещё раз: node src/check-relays.js");
}

main().catch((error) => {
  console.log(`   Проверка реле не удалась: ${error.message}`);
});
