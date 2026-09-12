// Подключение к SQLite через встроенный модуль node:sqlite (Node 22.13+):
// никаких нативных зависимостей и компиляции при npm install.
// Единственная точка создания базы и схемы: остальной код получает
// готовый объект db и не знает о деталях подключения.

import { DatabaseSync } from "node:sqlite";

import { DATABASE_PATH } from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tables (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'busy')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tariffs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  price_per_hour INTEGER NOT NULL CHECK (price_per_hour > 0),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS table_sessions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id                INTEGER NOT NULL REFERENCES tables (id) ON DELETE RESTRICT,
  tariff_id               INTEGER NOT NULL REFERENCES tariffs (id) ON DELETE RESTRICT,
  price_per_hour_snapshot INTEGER NOT NULL,
  started_at              TEXT NOT NULL,
  ended_at                TEXT,
  total_cost_kopecks      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_table ON table_sessions (table_id);
CREATE INDEX IF NOT EXISTS idx_sessions_open ON table_sessions (table_id)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS journal_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  message    TEXT NOT NULL,
  table_id   INTEGER REFERENCES tables (id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES table_sessions (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_created ON journal_entries (created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL
                CHECK (role IN ('developer', 'owner', 'manager', 'admin', 'cashier')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_open ON shifts (user_id) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS clients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  phone            TEXT,
  discount_percent INTEGER NOT NULL DEFAULT 0
                   CHECK (discount_percent BETWEEN 0 AND 100),
  note             TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  price      INTEGER NOT NULL CHECK (price > 0),
  category   TEXT NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES table_sessions (id) ON DELETE CASCADE,
  menu_item_id  INTEGER REFERENCES menu_items (id) ON DELETE SET NULL,
  item_name     TEXT NOT NULL,
  price_kopecks INTEGER NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  created_by    INTEGER REFERENCES users (id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_session ON session_orders (session_id);

CREATE TABLE IF NOT EXISTS bookings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id         INTEGER NOT NULL REFERENCES tables (id) ON DELETE CASCADE,
  client_name      TEXT NOT NULL,
  phone            TEXT,
  starts_at        TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  note             TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'cancelled')),
  created_by       INTEGER REFERENCES users (id),
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings (starts_at);

CREATE TABLE IF NOT EXISTS plan_elements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK (type IN ('wall', 'door', 'sofa', 'armchair', 'deco_table', 'tv')),
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  w          INTEGER NOT NULL CHECK (w > 0),
  h          INTEGER NOT NULL CHECK (h > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tariff_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tariff_id    INTEGER NOT NULL REFERENCES tariffs (id) ON DELETE CASCADE,
  days         TEXT NOT NULL,
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   INTEGER NOT NULL CHECK (end_minute BETWEEN 0 AND 1440),
  created_at   TEXT NOT NULL
);

-- Права ролей: настраиваются в «Настройки → Роли и права». Роль developer
-- в таблицу не попадает — у неё всегда полный доступ (страховка от
-- случайной потери прав всеми остальными ролями).
CREATE TABLE IF NOT EXISTS role_permissions (
  role       TEXT NOT NULL,
  permission TEXT NOT NULL,
  allowed    INTEGER NOT NULL,
  PRIMARY KEY (role, permission)
);

-- Акции «счастливый час»: процент скидки на время игры по дням недели
-- и часам. В отличие от тарифных расписаний, акция не меняет тариф, а
-- даёт скидку поверх любого тарифа.
CREATE TABLE IF NOT EXISTS promotions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  days             TEXT NOT NULL,
  start_minute     INTEGER NOT NULL,
  end_minute       INTEGER NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);

-- Движение денег в кассе помимо выручки: выдали на закупку, сдали
-- старшему (инкассация), внесли размен. Без этого расчётные наличные
-- в смене не сходятся с тем, что лежит в ящике.
CREATE TABLE IF NOT EXISTS cash_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id       INTEGER NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind           TEXT NOT NULL CHECK (kind IN ('in', 'out')),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_shift ON cash_movements (shift_id);

-- Чеки на остаток («клубный чек»). Гость заплатил фиксированную сумму,
-- не догулял оплаченное время — остаток не возвращается деньгами, а
-- выдаётся чеком: по коду с него можно доиграть в любой другой день.
-- Деньги при этом остаются в кассе, поэтому выручка признаётся сразу
-- при оплате, а игра «по чеку» новой выручки уже не даёт.
CREATE TABLE IF NOT EXISTS vouchers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL UNIQUE,
  amount_kopecks      INTEGER NOT NULL CHECK (amount_kopecks > 0),
  balance_kopecks     INTEGER NOT NULL CHECK (balance_kopecks >= 0),
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'used', 'cancelled')),
  client_id           INTEGER REFERENCES clients (id) ON DELETE SET NULL,
  source_session_id   INTEGER REFERENCES table_sessions (id) ON DELETE SET NULL,
  redeemed_session_id INTEGER REFERENCES table_sessions (id) ON DELETE SET NULL,
  created_by          INTEGER REFERENCES users (id),
  created_at          TEXT NOT NULL,
  redeemed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_vouchers_active ON vouchers (status);

-- Личные ограничения сотрудника: перебивают права его роли. Строки
-- появляются только там, где для конкретного человека решили иначе, чем
-- для всей роли; всё остальное берётся из role_permissions.
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  allowed    INTEGER NOT NULL,
  PRIMARY KEY (user_id, permission)
);

-- Ограничение выбора тарифа на конкретном столе. Пусто — можно выбрать
-- любой активный тариф (как раньше); есть строки — только перечисленные.
CREATE TABLE IF NOT EXISTS table_tariffs (
  table_id  INTEGER NOT NULL REFERENCES tables (id) ON DELETE CASCADE,
  tariff_id INTEGER NOT NULL REFERENCES tariffs (id) ON DELETE CASCADE,
  PRIMARY KEY (table_id, tariff_id)
);

-- Устройства зала, не связанные со столами: кондиционер, вытяжка, приток.
-- Сеансов и тарифов у них нет — только реле и цикл «поработало
-- work_minutes — постояло rest_minutes». Фаза считается арифметикой от
-- cycle_started_at, а не хранится: перезапуск программы или пропущенный
-- тик цикл не сбивают. Колонки реле названы как у столов — код привязки
-- и драйверы общие (см. lighting.js).
CREATE TABLE IF NOT EXISTS devices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  work_minutes     INTEGER NOT NULL DEFAULT 15 CHECK (work_minutes > 0),
  rest_minutes     INTEGER NOT NULL DEFAULT 30 CHECK (rest_minutes >= 0),
  cycle_on         INTEGER NOT NULL DEFAULT 0,
  cycle_started_at TEXT,
  is_on            INTEGER NOT NULL DEFAULT 0,
  light_kind       TEXT,
  light_host       TEXT,
  light_channel    INTEGER NOT NULL DEFAULT 0,
  light_on_url     TEXT,
  light_off_url    TEXT,
  tuya_device_id   TEXT,
  tuya_switch_code TEXT,
  created_at       TEXT NOT NULL
);
`;

/**
 * Роль в users создавалась с CHECK (role IN ('admin','cashier')), потом в
 * список добавились developer/owner, а затем manager (управляющий). SQLite
 * не умеет менять CHECK через ALTER TABLE, поэтому при необходимости
 * пересоздаём таблицу по стандартной 4-шаговой процедуре (copy → drop →
 * rename), сохраняя все данные. Проверяем по последней добавленной роли:
 * как только 'manager' есть в CHECK — схема актуальна и проход ничего
 * не делает.
 */
function migrateUserRoles(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!row || row.sql.includes("'manager'")) return; // уже актуальная схема
  // На users ссылаются другие таблицы (shifts, table_sessions, ...) — пока
  // мы её пересоздаём, эти ссылки на мгновение указывают в никуда, поэтому
  // проверку внешних ключей на время миграции отключаем (её нельзя менять
  // внутри транзакции, поэтому переключаем снаружи).
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    withTransaction(db, () => {
      db.exec(`
        CREATE TABLE users_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          login         TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL
                        CHECK (role IN ('developer', 'owner', 'manager', 'admin', 'cashier')),
          is_active     INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL
        );
        INSERT INTO users_new SELECT * FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * plan_elements создавалась с CHECK (type IN ('wall','door')) — до того как
 * в редактор зала добавили мебель (диван/кресло/стол/телевизор). Та же
 * пересборка таблицы, что и для ролей; на неё никто не ссылается, поэтому
 * без танцев с внешними ключами.
 */
function migratePlanElementTypes(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='plan_elements'")
    .get();
  if (!row || row.sql.includes("'sofa'")) return; // уже актуальная схема
  withTransaction(db, () => {
    db.exec(`
      CREATE TABLE plan_elements_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT NOT NULL CHECK (type IN ('wall', 'door', 'sofa', 'armchair', 'deco_table', 'tv')),
        x          INTEGER NOT NULL,
        y          INTEGER NOT NULL,
        w          INTEGER NOT NULL CHECK (w > 0),
        h          INTEGER NOT NULL CHECK (h > 0),
        created_at TEXT NOT NULL
      );
      INSERT INTO plan_elements_new SELECT * FROM plan_elements;
      DROP TABLE plan_elements;
      ALTER TABLE plan_elements_new RENAME TO plan_elements;
    `);
  });
}

/**
 * Версия схемы базы. Увеличивается, когда в схему добавляется что-то
 * новое: по этому числу сразу видно, «с какой программы» база, а если
 * клиент прислал копию — понятно, чего в ней ещё нет.
 *
 * Держится в самой базе (settings.schema_version) и показывается в
 * «Диагностике».
 */
export const SCHEMA_VERSION = 11;

/** Что появилось в каждой версии — для отчёта и для разбора жалоб. */
export const SCHEMA_HISTORY = [
  [1, "столы, тарифы, сеансы, журнал"],
  [2, "сотрудники, права, кассовые смены"],
  [3, "клиенты, скидки, бар"],
  [4, "план зала, брони, тарифные расписания"],
  [5, "предоплата: время и фиксированная сумма"],
  [6, "чеки на остаток («клубный чек»)"],
  [7, "движение денег в кассе, автокопии базы"],
  [8, "акции, подарочные часы, оплата труда"],
  [9, "напоминания о бронях, вид чека, подарочные чеки"],
  [10, "реле по локальной сети: Tasmota, Shelly, свой адрес"],
  [11, "устройства зала по циклу: кондиционер, вытяжка, приток"],
];

/** Записывает версию схемы в саму базу — после того как схема доросла. */
function stampSchemaVersion(db) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
}

/** Версия схемы, записанная в базе (0 — база старше этой возможности). */
export function schemaVersionOf(db) {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get();
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

/** Добавляет колонку в существующую базу, если её ещё нет (миграция). */
function ensureColumn(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * Открывает базу и создаёт недостающие таблицы.
 * @param {string} [filePath] путь к файлу БД (в тестах — ":memory:")
 * @returns {DatabaseSync}
 */
export function createDatabase(filePath = DATABASE_PATH) {
  const db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  migrateUserRoles(db);
  migratePlanElementTypes(db);
  // План зала: позиция и размер стола в клетках сетки (NULL = ещё не расставлен).
  ensureColumn(db, "tables", "pos_x", "pos_x INTEGER");
  ensureColumn(db, "tables", "pos_y", "pos_y INTEGER");
  ensureColumn(db, "tables", "size_w", "size_w INTEGER NOT NULL DEFAULT 4");
  ensureColumn(db, "tables", "size_h", "size_h INTEGER NOT NULL DEFAULT 3");
  // Привязка стола к реле Tuya/MOES (настраивается во вкладке «Настройки»).
  ensureColumn(db, "tables", "tuya_device_id", "tuya_device_id TEXT");
  ensureColumn(db, "tables", "tuya_switch_code", "tuya_switch_code TEXT");
  // Тип точки: бильярдный стол, PlayStation и т.д. — сеансы и тарифы у всех
  // общие, отличается только подпись/иконка на плитке.
  ensureColumn(db, "tables", "kind", "kind TEXT NOT NULL DEFAULT 'billiard'");
  // Кто и в какую кассовую смену открыл/закрыл сеанс.
  ensureColumn(db, "table_sessions", "opened_by", "opened_by INTEGER REFERENCES users (id)");
  ensureColumn(db, "table_sessions", "closed_by", "closed_by INTEGER REFERENCES users (id)");
  ensureColumn(db, "table_sessions", "shift_id", "shift_id INTEGER REFERENCES shifts (id)");
  ensureColumn(db, "table_sessions", "close_shift_id", "close_shift_id INTEGER REFERENCES shifts (id)");
  // Предоплата: оплаченное время (сек) и сумма (коп); NULL = постоплата.
  ensureColumn(db, "table_sessions", "prepaid_seconds", "prepaid_seconds INTEGER");
  ensureColumn(db, "table_sessions", "prepaid_kopecks", "prepaid_kopecks INTEGER");
  // Оплата, клиент и разбивка итога сеанса.
  ensureColumn(db, "table_sessions", "payment_method", "payment_method TEXT");
  ensureColumn(db, "table_sessions", "client_id", "client_id INTEGER REFERENCES clients (id)");
  ensureColumn(db, "table_sessions", "discount_percent", "discount_percent INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "table_sessions", "time_cost_kopecks", "time_cost_kopecks INTEGER");
  ensureColumn(db, "table_sessions", "bar_cost_kopecks", "bar_cost_kopecks INTEGER");
  // Пересдача кассы: наличные на начало и конец смены.
  ensureColumn(db, "shifts", "opening_cash_kopecks", "opening_cash_kopecks INTEGER");
  ensureColumn(db, "shifts", "closing_cash_kopecks", "closing_cash_kopecks INTEGER");
  // Удаление стола: если по нему уже есть история сеансов — стол не
  // удаляется физически (сломало бы историю), а просто скрывается.
  ensureColumn(db, "tables", "is_active", "is_active INTEGER NOT NULL DEFAULT 1");
  // Бесплатное время: сеанс идёт, но время не тарифицируется (бар — как обычно).
  ensureColumn(db, "table_sessions", "is_free", "is_free INTEGER NOT NULL DEFAULT 0");
  // Как открыли предоплату: time (на время), amount (чек на сумму) или
  // voucher (по чеку на остаток). От режима зависит расчёт при закрытии:
  // на время — сдача деньгами, чек на сумму — остаток чеком.
  ensureColumn(db, "table_sessions", "prepaid_mode", "prepaid_mode TEXT");
  // Часть предоплаты, пришедшая чеком на остаток: эти деньги в кассе
  // появились раньше, поэтому в выручку сеанса они не попадают повторно.
  ensureColumn(
    db,
    "table_sessions",
    "voucher_kopecks",
    "voucher_kopecks INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(db, "table_sessions", "voucher_id", "voucher_id INTEGER REFERENCES vouchers (id)");
  // Сколько по этому сеансу списано со счёта клиента (пополнения). Эти
  // деньги пришли в кассу раньше — в выручку они попадают в день игры,
  // но наличными/картой этой смены их считать нельзя, иначе касса
  // «не сойдётся»: их уже посчитали при пополнении.
  ensureColumn(
    db,
    "table_sessions",
    "account_kopecks",
    "account_kopecks INTEGER NOT NULL DEFAULT 0"
  );
  // Акция «каждый N-й час в подарок»: сколько подарочных часов клиенту
  // уже начислено — чтобы не выдать один и тот же подарок дважды.
  ensureColumn(
    db,
    "clients",
    "bonus_hours_awarded",
    "bonus_hours_awarded INTEGER NOT NULL DEFAULT 0"
  );
  // Скидка акции, зафиксированная при открытии сеанса: нужна для чека и
  // отчётов («почему тут дешевле»).
  ensureColumn(db, "table_sessions", "promo_name", "promo_name TEXT");
  // Схема доросла до текущей версии — отмечаем это в самой базе.
  // Чем выдан чек: change — остаток от чека на сумму, bonus — подарок за
  // наигранные часы. По одному сеансу может быть и то, и другое.
  ensureColumn(db, "vouchers", "kind", "kind TEXT NOT NULL DEFAULT 'change'");
  // Чем управляется свет над столом: tuya (облако MOES/Tuya), tasmota,
  // shelly или url («своё устройство» — два адреса). Пусто — света нет.
  ensureColumn(db, "tables", "light_kind", "light_kind TEXT");
  ensureColumn(db, "tables", "light_host", "light_host TEXT");
  ensureColumn(db, "tables", "light_channel", "light_channel INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tables", "light_on_url", "light_on_url TEXT");
  ensureColumn(db, "tables", "light_off_url", "light_off_url TEXT");
  // Напоминание о брони уже отправлено — второй раз не пишем.
  ensureColumn(db, "bookings", "reminded_at", "reminded_at TEXT");
  // Оплата труда: часовая ставка и процент от выручки закрытых смен.
  // Ноль — значит эта часть не начисляется.
  ensureColumn(
    db,
    "users",
    "hourly_rate_kopecks",
    "hourly_rate_kopecks INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "users",
    "revenue_percent",
    "revenue_percent INTEGER NOT NULL DEFAULT 0"
  );
  stampSchemaVersion(db);
  return db;
}

/**
 * Выполняет fn внутри транзакции: всё или ничего.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Текущее время в UTC в формате ISO-8601 (так оно хранится в базе). */
export function utcNow() {
  return new Date().toISOString();
}
