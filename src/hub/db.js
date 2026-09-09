// База центральной панели («хаба») — отдельная от базы клуба.
//
// Почему отдельная. База клуба живёт на компьютере самого клуба: её
// восстанавливают из копии, переносят, чинят «доктором». Данные о
// подписках и оплатах к клубу отношения не имеют и потеряться вместе с
// его базой не должны — поэтому у хаба свой файл и своя схема.
//
// Клубы в хабе — это карточки, а не сами базы: клуб работает у себя, а
// сюда лишь отмечается («я на связи») и получает ответ, оплачен ли он.

import { DatabaseSync } from "node:sqlite";

import { HUB_DATABASE_PATH } from "../config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hub_sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES hub_users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Тарифные планы сервиса: что клуб платит за подписку.
CREATE TABLE IF NOT EXISTS plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  price_kopecks INTEGER NOT NULL CHECK (price_kopecks >= 0),
  period_days   INTEGER NOT NULL DEFAULT 30 CHECK (period_days > 0),
  max_tables    INTEGER,
  description   TEXT NOT NULL DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clubs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  city             TEXT NOT NULL DEFAULT '',
  owner_name       TEXT NOT NULL DEFAULT '',
  phone            TEXT NOT NULL DEFAULT '',
  email            TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  plan_id          INTEGER REFERENCES plans (id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'trial'
                     CHECK (status IN ('trial', 'active', 'overdue', 'blocked', 'archived')),
  -- До какой даты оплачено. Пока клуб на пробном периоде — это его конец.
  paid_until       TEXT,
  -- Отсрочка блокировки: «дал ещё неделю, оплатят позже».
  grace_until      TEXT,
  -- Блокировка руками: сильнее любого расчёта по датам.
  blocked_manually INTEGER NOT NULL DEFAULT 0,
  -- Ключ, которым программа клуба отмечается на связи.
  api_key          TEXT NOT NULL UNIQUE,
  last_seen_at     TEXT,
  app_version      TEXT,
  tables_count     INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clubs_status ON clubs (status);

CREATE TABLE IF NOT EXISTS club_payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id        INTEGER NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
  days           INTEGER NOT NULL CHECK (days > 0),
  -- До какой даты продлили этой оплатой (для истории: «за что платили»).
  paid_until     TEXT NOT NULL,
  method         TEXT NOT NULL DEFAULT 'cash',
  comment        TEXT NOT NULL DEFAULT '',
  created_by     INTEGER REFERENCES hub_users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_club ON club_payments (club_id);

CREATE TABLE IF NOT EXISTS hub_journal (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  message    TEXT NOT NULL,
  club_id    INTEGER REFERENCES clubs (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hub_journal_created ON hub_journal (created_at);

-- Сообщения клубам: либо одному (club_id), либо всем сразу (NULL).
CREATE TABLE IF NOT EXISTS hub_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  club_id    INTEGER REFERENCES clubs (id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES hub_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_reads (
  message_id INTEGER NOT NULL REFERENCES hub_messages (id) ON DELETE CASCADE,
  club_id    INTEGER NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, club_id)
);

-- Одноразовый вход «от лица клуба» для поддержки. Сам вход выполняет
-- программа клуба, здесь — выдача и журнал: кто, когда и зачем заходил.
CREATE TABLE IF NOT EXISTS support_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id    INTEGER NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  reason     TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES hub_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS hub_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Значения по умолчанию: пробный период, отсрочка после просрочки и с
// какого молчания считать клуб «потерявшимся».
const DEFAULT_SETTINGS = {
  currency: "сум",
  trial_days: "14",
  grace_days: "5",
  // Через сколько часов молчания клуб попадает в «давно не на связи».
  offline_hours: "24",
  // За сколько дней предупреждать об окончании подписки.
  expiry_warning_days: "7",
};

/**
 * Открывает (и при необходимости создаёт) базу центральной панели.
 * @param {string} [filePath]
 */
export function createHubDatabase(filePath = HUB_DATABASE_PATH) {
  const db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT INTO hub_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING"
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
  return db;
}

/** Настройки хаба одним объектом (значения — строки, как в базе). */
export function hubSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare("SELECT key, value FROM hub_settings").all()) {
    out[row.key] = row.value;
  }
  return out;
}

/** Число из настроек хаба с запасным значением. */
export function hubNumber(db, key) {
  const value = Number(hubSettings(db)[key]);
  return Number.isFinite(value) ? value : Number(DEFAULT_SETTINGS[key]);
}

/** Сохраняет настройки хаба (только известные ключи). */
export function saveHubSettings(db, patch) {
  const stmt = db.prepare(
    "INSERT INTO hub_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  );
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key in DEFAULT_SETTINGS) stmt.run(key, String(value));
  }
  return hubSettings(db);
}
