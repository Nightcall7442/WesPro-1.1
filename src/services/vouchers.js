// Чеки на остаток («клубный чек»).
//
// Гость открыл чек на фиксированную сумму, но не догулял оплаченное
// время — остаток не возвращается деньгами: на него выдаётся чек с
// коротким кодом, по которому можно доиграть в любой другой день.
//
// Про деньги. Оплата попадает в выручку сразу, при открытии чека
// (деньги остаются в кассе, сдачи нет). Поэтому игра «по чеку» новой
// выручки не даёт: в сеансе такая часть помечена как voucher_kopecks и
// в итог не включается — иначе одни и те же деньги попали бы в отчёт
// дважды.

import { randomInt } from "node:crypto";

import { utcNow, withTransaction } from "../db.js";
import { kopecksToRubles, rublesToKopecks } from "./billing.js";
import { getClient } from "./clients.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";
import { getClubSettings } from "./settings.js";
import { addCashMovement, requireShiftFor } from "./shifts.js";

// Способы оплаты пополнения счёта — те же, что при закрытии сеанса.
const PAYMENT_METHODS = ["cash", "card", "transfer"];

const VOUCHER_FIELDS = `
  v.id, v.code, v.amount_kopecks, v.balance_kopecks, v.status, v.kind,
  v.client_id, v.source_session_id, v.redeemed_session_id,
  v.created_at, v.redeemed_at,
  c.name AS client_name, u.name AS created_by_name
`;

const VOUCHER_JOIN = `
  FROM vouchers v
  LEFT JOIN clients c ON c.id = v.client_id
  LEFT JOIN users u ON u.id = v.created_by
`;

/**
 * Код чека: «Ч-» и четыре цифры — короткий, чтобы прочитать с бумажки
 * и продиктовать по телефону. При совпадении пробуем ещё раз.
 */
function generateCode(db) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = `Ч-${String(randomInt(1000, 10000))}`;
    if (!db.prepare("SELECT id FROM vouchers WHERE code = ?").get(code)) {
      return code;
    }
  }
  // Практически недостижимо: 9000 кодов и 50 попыток.
  throw new ConflictError("Не удалось подобрать свободный код чека");
}

/** @param {object} row */
export function voucherToOut(row) {
  return {
    id: row.id,
    code: row.code,
    amount: kopecksToRubles(row.amount_kopecks),
    balance: kopecksToRubles(row.balance_kopecks),
    status: row.status,
    kind: row.kind ?? "change",
    client_id: row.client_id ?? null,
    client_name: row.client_name ?? null,
    source_session_id: row.source_session_id ?? null,
    redeemed_session_id: row.redeemed_session_id ?? null,
    created_at: row.created_at,
    redeemed_at: row.redeemed_at ?? null,
    created_by_name: row.created_by_name ?? null,
  };
}

export function getVoucher(db, voucherId) {
  const row = db
    .prepare(`SELECT ${VOUCHER_FIELDS} ${VOUCHER_JOIN} WHERE v.id = ?`)
    .get(voucherId);
  if (!row) throw new NotFoundError(`Чек id=${voucherId} не найден`);
  return row;
}

/**
 * Чек по коду. Код ищется без учёта регистра и лишних пробелов, а «Ч-»
 * можно не набирать: кассир часто вводит просто цифры.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} code
 */
export function findVoucherByCode(db, code) {
  const text = String(code ?? "").trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  const row =
    db
      .prepare(`SELECT ${VOUCHER_FIELDS} ${VOUCHER_JOIN} WHERE v.code = ? COLLATE NOCASE`)
      .get(text) ??
    (digits
      ? db
          .prepare(`SELECT ${VOUCHER_FIELDS} ${VOUCHER_JOIN} WHERE v.code = ?`)
          .get(`Ч-${digits}`)
      : null);
  return row ?? null;
}

/**
 * Чек, годный к игре: существует, активен и с остатком.
 * Бросает понятную ошибку — её текст кассир увидит в интерфейсе.
 */
export function requireUsableVoucher(db, code) {
  const voucher = findVoucherByCode(db, code);
  if (!voucher) {
    throw new ConflictError(`Чек «${code}» не найден — проверьте код`);
  }
  if (voucher.status === "cancelled") {
    throw new ConflictError(`Чек ${voucher.code} отменён`);
  }
  if (voucher.status === "used" || voucher.balance_kopecks <= 0) {
    throw new ConflictError(`Чек ${voucher.code} уже использован`);
  }
  return voucher;
}

/**
 * Выдаёт чек на остаток.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{amountKopecks: number, clientId?: number | null,
 *          sourceSessionId?: number | null,
 *          user?: {id: number, name: string} | null}} data
 */
export function createVoucher(
  db,
  { amountKopecks, clientId = null, sourceSessionId = null, user = null, kind = "change" }
) {
  const amount = Math.round(Number(amountKopecks));
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ConflictError("Сумма чека должна быть больше нуля");
  }
  const code = generateCode(db);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO vouchers
         (code, amount_kopecks, balance_kopecks, status, kind, client_id,
          source_session_id, created_by, created_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    )
    .run(code, amount, amount, kind, clientId, sourceSessionId, user?.id ?? null, utcNow());
  const voucher = getVoucher(db, Number(lastInsertRowid));
  const kindLabel =
    kind === "bonus"
      ? "Выдан подарочный чек"
      : kind === "topup"
        ? "Пополнен счёт клиента"
        : "Выдан чек на остаток";
  logEvent(
    db,
    kind === "topup" ? JournalEvent.CLIENT_TOPUP : JournalEvent.SESSION_CLOSED,
    `${kindLabel} ${voucher.code} — ` +
      `${kopecksToRubles(amount).toFixed(2)} ${getClubSettings(db).currency}` +
      (voucher.client_name ? `, клиент «${voucher.client_name}»` : "") +
      (user ? ` — ${user.name}` : ""),
    { sessionId: sourceSessionId ?? undefined }
  );
  return voucher;
}

/**
 * Списывает чек целиком на время сеанса: пока гость играет, чек занят и
 * повторно открыть по нему другой стол нельзя. Если гость не доиграет,
 * остаток вернётся на ЭТОТ ЖЕ чек при закрытии — см. reissueVoucher.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} voucherId
 * @param {number} sessionId
 */
export function redeemVoucher(db, voucherId, sessionId) {
  const voucher = getVoucher(db, voucherId);
  if (voucher.status !== "active" || voucher.balance_kopecks <= 0) {
    throw new ConflictError(`Чек ${voucher.code} уже использован`);
  }
  db.prepare(
    `UPDATE vouchers
       SET balance_kopecks = 0, status = 'used',
           redeemed_session_id = ?, redeemed_at = ?
     WHERE id = ?`
  ).run(sessionId, utcNow(), voucher.id);
  return getVoucher(db, voucher.id);
}

/**
 * Возвращает недоигранный остаток на ТОТ ЖЕ чек: код у гостя не меняется,
 * сколько бы раз он ни приходил доигрывать. Раньше на каждый круг
 * выдавался новый код, и гость путался, каким из них платить.
 *
 * Правила: код и дата выдачи неприкосновенны; остаток — новый; номинал
 * не уменьшаем (гость мог доплатить деньгами и увеличить остаток); чек
 * снова действующий, поэтому отметку о погашении снимаем.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} voucherId
 * @param {number} amountKopecks остаток, который возвращается на чек
 * @param {{sourceSessionId?: number | null,
 *          user?: {id: number, name: string} | null}} [options]
 */
export function reissueVoucher(db, voucherId, amountKopecks, { user = null } = {}) {
  const voucher = getVoucher(db, voucherId);
  const amount = Math.round(Number(amountKopecks));
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ConflictError("Остаток чека должен быть больше нуля");
  }
  if (voucher.status === "cancelled") {
    // Чек отменили, пока гость играл. Воскрешать отменённое нельзя —
    // вызывающий выдаст новый чек, закрытие стола падать не должно.
    throw new ConflictError(`Чек ${voucher.code} отменён`);
  }
  db.prepare(
    `UPDATE vouchers
       SET balance_kopecks = ?,
           amount_kopecks = MAX(amount_kopecks, ?),
           status = 'active',
           redeemed_session_id = NULL,
           redeemed_at = NULL
     WHERE id = ?`
  ).run(amount, amount, voucher.id);
  const updated = getVoucher(db, voucher.id);
  logEvent(
    db,
    JournalEvent.SESSION_CLOSED,
    `Остаток ${kopecksToRubles(amount).toFixed(2)} ${getClubSettings(db).currency} ` +
      `вернулся на чек ${updated.code} (код прежний)` +
      (updated.client_name ? `, клиент «${updated.client_name}»` : "") +
      (user ? ` — ${user.name}` : "")
  );
  return updated;
}

/**
 * Отменяет чек (ошиблись при выдаче). Использованный чек не отменяем:
 * по нему уже играли, и отмена сломала бы историю.
 */
export function cancelVoucher(db, voucherId, user) {
  const voucher = getVoucher(db, voucherId);
  if (voucher.status === "used") {
    throw new ConflictError(`Чек ${voucher.code} уже использован — его нельзя отменить`);
  }
  if (voucher.status === "cancelled") return voucherToOut(voucher);
  withTransaction(db, () => {
    db.prepare(
      "UPDATE vouchers SET status = 'cancelled', balance_kopecks = 0 WHERE id = ?"
    ).run(voucher.id);
    logEvent(
      db,
      JournalEvent.SESSION_CLOSED,
      `Отменён чек на остаток ${voucher.code} — ${user.name}`
    );
  });
  return voucherToOut(getVoucher(db, voucher.id));
}

/**
 * Список чеков. По умолчанию — только действующие: их и ищут, когда
 * гость приходит доигрывать.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{status?: string, clientId?: number, kind?: string, limit?: number}} [options]
 */
export function listVouchers(
  db,
  { status = "active", clientId = null, kind = null, limit = 200 } = {}
) {
  const where = [];
  const params = [];
  if (status && status !== "all") {
    where.push("v.status = ?");
    params.push(status);
  }
  if (clientId) {
    where.push("v.client_id = ?");
    params.push(clientId);
  }
  if (kind) {
    where.push("v.kind = ?");
    params.push(kind);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT ${VOUCHER_FIELDS} ${VOUCHER_JOIN}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY v.created_at DESC LIMIT ?`
    )
    .all(...params)
    .map(voucherToOut);
}

/**
 * Пополнение счёта клиента: касса принимает деньги заранее, а не в
 * момент открытия стола, и выдаёт клиенту чек на эту сумму — им можно
 * будет расплатиться за любой стол так же, как обычным чеком на остаток.
 * Наличные пополнения сразу же кладутся в кассу (движение «внесение»),
 * чтобы касса сходилась при закрытии смены.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} clientId
 * @param {{id: number, name: string, role: string}} user
 * @param {{amount: number, paymentMethod?: string}} data
 */
export function topUpClient(db, clientId, user, { amount, paymentMethod = "cash" } = {}) {
  const client = getClient(db, clientId);
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new ConflictError(
      `Недопустимый способ оплаты «${paymentMethod}» (cash, card или transfer)`
    );
  }
  const rubles = Number(amount);
  if (!Number.isFinite(rubles) || rubles <= 0) {
    throw new ConflictError("Сумма пополнения должна быть больше нуля");
  }
  // Смена нужна для любого способа оплаты — иначе пополнение проходит
  // мимо кассы и его некому подтвердить при сверке.
  requireShiftFor(db, user);

  let voucher;
  withTransaction(db, () => {
    voucher = createVoucher(db, {
      amountKopecks: rublesToKopecks(rubles),
      clientId: client.id,
      user,
      kind: "topup",
    });
    if (paymentMethod === "cash") {
      addCashMovement(db, user, {
        kind: "in",
        amount: rubles,
        reason: `Пополнение счёта клиента «${client.name}» (чек ${voucher.code})`,
      });
    }
  });
  return voucher;
}

/**
 * Счёт клиента — деньги, которые он внёс заранее («Касса» → «Пополнить
 * счёт»). Это только пополнения: чеки на остаток и подарочные чеки лежат
 * у гостя на руках с кодом, сами собой они не списываются.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number | null} clientId
 * @returns {number} остаток счёта в копейках
 */
export function clientAccountKopecks(db, clientId) {
  if (!clientId) return 0;
  return db
    .prepare(
      `SELECT COALESCE(SUM(balance_kopecks), 0) AS total
         FROM vouchers
        WHERE client_id = ? AND kind = 'topup' AND status = 'active'`
    )
    .get(clientId).total;
}

/**
 * Списывает со счёта клиента сколько получится, но не больше запрошенного.
 * Пополнения тратятся по очереди — сначала самое старое: так деньги не
 * «зависают» на давнем пополнении, и остаток счёта расходуется предсказуемо.
 *
 * Овердрафта нет: если на счету меньше нужного, спишется сколько есть, а
 * остальное кассир возьмёт деньгами. Пополнение, дошедшее до нуля,
 * помечается использованным — иначе оно так и висело бы в списке чеков.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number | null} clientId
 * @param {number} amountKopecks сколько хотим списать
 * @param {{sessionId?: number | null,
 *          user?: {id: number, name: string} | null}} [options]
 * @returns {number} сколько списали (0 — счёт пуст или списывать нечего)
 */
export function debitClientAccount(db, clientId, amountKopecks, { sessionId = null, user = null } = {}) {
  const want = Math.round(Number(amountKopecks));
  if (!clientId || !Number.isInteger(want) || want <= 0) return 0;
  const rows = db
    .prepare(
      `SELECT id, code, balance_kopecks FROM vouchers
        WHERE client_id = ? AND kind = 'topup' AND status = 'active'
          AND balance_kopecks > 0
        ORDER BY created_at, id`
    )
    .all(clientId);

  let left = want;
  let taken = 0;
  for (const row of rows) {
    if (left <= 0) break;
    const part = Math.min(left, row.balance_kopecks);
    const rest = row.balance_kopecks - part;
    if (rest === 0) {
      // Пополнение израсходовано до конца — помечаем использованным,
      // иначе оно так и висело бы в списке действующих чеков.
      db.prepare(
        `UPDATE vouchers
            SET balance_kopecks = 0, status = 'used',
                redeemed_session_id = COALESCE(redeemed_session_id, ?),
                redeemed_at = ?
          WHERE id = ?`
      ).run(sessionId, utcNow(), row.id);
    } else {
      db.prepare("UPDATE vouchers SET balance_kopecks = ? WHERE id = ?").run(rest, row.id);
    }
    left -= part;
    taken += part;
  }

  if (taken > 0) {
    const client = getClient(db, clientId);
    logEvent(
      db,
      JournalEvent.CLIENT_DEBIT,
      `Со счёта клиента «${client.name}» списано ` +
        `${kopecksToRubles(taken).toFixed(2)} ${getClubSettings(db).currency}` +
        `, остаток счёта ${kopecksToRubles(clientAccountKopecks(db, clientId)).toFixed(2)}` +
        (user ? ` — ${user.name}` : ""),
      { sessionId: sessionId ?? undefined }
    );
  }
  return taken;
}

/**
 * Возвращает деньги на счёт клиента — например, когда он оплатил час со
 * счёта, а доиграл только полчаса: разницу нельзя выдать из кассы (этих
 * денег там сейчас нет, они пришли при пополнении), поэтому она ложится
 * обратно на счёт.
 *
 * Чтобы у гостя не плодились коды, доливаем в самое свежее действующее
 * пополнение; если все израсходованы — заводим новое.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number | null} clientId
 * @param {number} amountKopecks
 * @param {{user?: {id: number, name: string} | null}} [options]
 * @returns {number} сколько вернули
 */
export function creditClientAccount(db, clientId, amountKopecks, { user = null } = {}) {
  const amount = Math.round(Number(amountKopecks));
  if (!clientId || !Number.isInteger(amount) || amount <= 0) return 0;
  const latest = db
    .prepare(
      `SELECT id FROM vouchers
        WHERE client_id = ? AND kind = 'topup' AND status = 'active'
        ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(clientId);
  if (latest) {
    db.prepare(
      `UPDATE vouchers
          SET balance_kopecks = balance_kopecks + ?,
              amount_kopecks = MAX(amount_kopecks, balance_kopecks + ?)
        WHERE id = ?`
    ).run(amount, amount, latest.id);
  } else {
    createVoucher(db, { amountKopecks: amount, clientId, user, kind: "topup" });
  }
  const client = getClient(db, clientId);
  logEvent(
    db,
    JournalEvent.CLIENT_TOPUP,
    `На счёт клиента «${client.name}» возвращено ` +
      `${kopecksToRubles(amount).toFixed(2)} ${getClubSettings(db).currency} ` +
      `за неиспользованное оплаченное время` +
      (user ? ` — ${user.name}` : "")
  );
  return amount;
}
