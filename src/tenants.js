// Клубы сети: у каждого своя база и свой экземпляр программы.
//
// Почему так, а не общие таблицы с колонкой club_id. Разделение по
// файлам делает утечку между клубами структурно невозможной: обрабатывая
// запрос одного клуба, программа физически не имеет подключения к базе
// другого. При общих таблицах достаточно один раз забыть условие
// «AND club_id = ?» в одном из сотни запросов, чтобы кассир одного клуба
// увидел выручку соседнего.
//
// Приятное следствие: вся деловая логика (src/services/*) и все маршруты
// (src/routes/api.js) остались как есть — они и раньше принимали базу
// параметром, а createApp() и раньше был фабрикой. Мультиарендность
// добавлена снаружи, а не размазана по коду.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createApp } from "./app.js";
import { CLUBS_DIR } from "./config.js";
import { createDatabase } from "./db.js";
import { hubSettings } from "./hub/db.js";
import { seedNetworkClub } from "./seed.js";
import { startDeviceCycles } from "./services/devices.js";
import { initLighting } from "./services/lighting.js";
import { SUPPORT_LOGIN_PREFIX } from "./services/auth.js";
import { JournalEvent, logEvent } from "./services/journal.js";
import { saveSettings } from "./services/settings.js";
import { createUser } from "./services/users.js";

/**
 * Реестр клубов сети: по карточке клуба выдаёт его базу и приложение,
 * заводя их при первом обращении.
 *
 * Заводим лениво, а не при регистрации: брошенные на полпути регистрации
 * не оставляют пустых баз, а клубы, заведённые в панели сети вручную,
 * получают программу без отдельного действия.
 *
 * @param {import("node:sqlite").DatabaseSync} hubDb
 * @param {{dir?: string}} [options]
 */
export function createTenants(hubDb, { dir = CLUBS_DIR } = {}) {
  /** @type {Map<number, {db: import("node:sqlite").DatabaseSync, app: import("express").Express, timer?: NodeJS.Timeout}>} */
  const opened = new Map();

  const ownerRow = (clubId) =>
    hubDb
      .prepare("SELECT name, email, owner_name, password_hash, api_key FROM clubs WHERE id = ?")
      .get(clubId);

  function provision(db, clubId) {
    const club = ownerRow(clubId);
    if (club?.email && club.password_hash) {
      seedNetworkClub(db, {
        login: club.email,
        name: club.owner_name || club.name,
        password_hash: club.password_hash,
      });
    }
    // Программа сразу знает, как её зовут, в какой валюте она считает и
    // каким ключом отмечается в сети: владельцу не нужно переписывать
    // ключ из кабинета руками.
    saveSettings(db, {
      club_name: club?.name ?? "Бильярдный клуб",
      currency: hubSettings(hubDb).currency,
      wespro_club_key: club?.api_key ?? "",
    });
  }

  return {
    /**
     * База и приложение клуба. Карточка нужна только ради id — всё
     * остальное берётся из хаба заново, чтобы не зависеть от того,
     * насколько свежую строку передал вызывающий.
     * @param {{id: number}} club
     */
    for(club) {
      const cached = opened.get(club.id);
      if (cached) return cached;
      const file = path.join(dir, String(club.id), "billiards.db");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = createDatabase(file);
      const fresh = !db.prepare("SELECT id FROM users LIMIT 1").get();
      if (fresh) provision(db, club.id);
      // Без hubDb: панель сети и личный кабинет живут снаружи, в общем
      // приложении. Клуб не должен получить к ним доступ даже случайно.
      const tenant = { db, app: createApp(db) };
      opened.set(club.id, tenant);
      // Реле (облако Tuya достижимо и с хостинга) и цикл устройств зала —
      // с момента открытия базы, а не после первого сохранения настроек.
      initLighting(db)
        .catch(() => {}) // реле не критичны: клуб работает и без них
        .then(() => {
          if (opened.get(club.id) === tenant) tenant.timer = startDeviceCycles(db);
        });
      return tenant;
    },

    /**
     * Клуб, у которого база уже заведена, — открытой или с диска; null,
     * если её ещё нет. В отличие от for(), базу не заводит: панели сети
     * нечего показать по клубу, который ни разу не открывал программу.
     * @param {{id: number}} club
     */
    peek(club) {
      if (opened.has(club.id)) return opened.get(club.id);
      const file = path.join(dir, String(club.id), "billiards.db");
      return fs.existsSync(file) ? this.for(club) : null;
    },

    /**
     * Открывает базы уже заведённых клубов. Нужно при запуске сервера:
     * цикл устройств зала должен идти и без единого запроса от клуба.
     * Папки без базы (брошенные регистрации) не трогаем.
     */
    openExisting() {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return 0; // папки клубов ещё нет — ни одного клуба не заведено
      }
      let count = 0;
      for (const name of names) {
        const id = Number(name);
        if (!Number.isInteger(id)) continue;
        if (!fs.existsSync(path.join(dir, name, "billiards.db"))) continue;
        this.for({ id });
        count += 1;
      }
      return count;
    },

    /** Аккаунт владельца в программе клуба (тот, что заведён при регистрации). */
    ownerUser(club) {
      const { db } = this.for(club);
      const email = String(ownerRow(club.id)?.email ?? "").toLowerCase();
      return (
        db
          .prepare("SELECT * FROM users WHERE login = ? COLLATE NOCASE AND is_active = 1")
          .get(email) ?? null
      );
    },

    /**
     * Аккаунт разработчика поддержки в программе клуба — для входа из
     * панели сети. У каждого сотрудника панели свой: support:<логин>,
     * роль «разработчик» (полный доступ, в обход прав), пароля никто не
     * знает — вход только сессией из панели. Вход пишется в журнал клуба,
     * а пока сессия жива, клуб видит предупреждение в шапке.
     * @param {{id: number}} club
     * @param {{login: string, name: string}} hubUser
     */
    supportUser(club, hubUser) {
      const { db } = this.for(club);
      const login = `${SUPPORT_LOGIN_PREFIX}${hubUser.login}`;
      const name = `Поддержка WesPro — ${hubUser.name}`;
      let user = db.prepare("SELECT * FROM users WHERE login = ? COLLATE NOCASE").get(login);
      if (user) {
        if (!user.is_active || user.name !== name) {
          db.prepare("UPDATE users SET is_active = 1, name = ? WHERE id = ?").run(name, user.id);
        }
      } else {
        user = createUser(
          db,
          { login, name, password: randomBytes(18).toString("hex"), role: "developer" },
          { id: 0, name: "Панель сети", role: "developer" }
        );
      }
      logEvent(
        db,
        JournalEvent.SUPPORT_LOGIN,
        `В программу вошёл разработчик поддержки WesPro — ${hubUser.name}`
      );
      return user;
    },

    /**
     * Смена пароля в кабинете меняет и пароль входа в программу: для
     * владельца это один и тот же пароль, и расхождение выглядело бы
     * поломкой («в кабинет пускает, в программу нет»).
     */
    syncOwnerPassword(clubId) {
      const tenant = opened.get(clubId);
      if (!tenant) return; // база ещё не заведена — заведётся уже с новым хэшем
      const club = ownerRow(clubId);
      if (!club?.email || !club.password_hash) return;
      tenant.db
        .prepare("UPDATE users SET password_hash = ? WHERE login = ? COLLATE NOCASE")
        .run(club.password_hash, String(club.email).toLowerCase());
    },

    /** Закрывает все открытые базы (завершение работы, тесты). */
    close() {
      for (const { db, timer } of opened.values()) {
        clearInterval(timer);
        db.close();
      }
      opened.clear();
    },
  };
}
