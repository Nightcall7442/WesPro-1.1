// Открытие и закрытие сеансов — ядро бизнес-логики клуба.
//
// Правила:
// - открыть сеанс можно только на свободном столе;
// - закрыть сеанс можно только на занятом столе (с открытым сеансом);
// - цена фиксируется на момент открытия (снимок тарифа);
// - при открытии включается свет над столом, при закрытии — выключается;
// - каждое действие фиксируется в журнале.

import { utcNow, withTransaction } from "../db.js";
import {
  applyDiscount,
  costKopecks,
  kopecksToRubles,
  roundToStep,
} from "./billing.js";
import { getClient } from "./clients.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { JournalEvent, logEvent } from "./journal.js";
import { getLightingController } from "./lighting.js";
import { activePromotion } from "./promotions.js";
import { getClubSettings, getSettings } from "./settings.js";
import { requireShiftFor } from "./shifts.js";
import { getAllowedTariffIds, getTable, resolveTableTariffId } from "./tables.js";
import { resolveTariffId } from "./tariff-rules.js";
import { getTariff } from "./tariffs.js";
import {
  clientAccountKopecks,
  createVoucher,
  creditClientAccount,
  debitClientAccount,
  redeemVoucher,
  reissueVoucher,
  requireUsableVoucher,
} from "./vouchers.js";

export const PAYMENT_METHODS = ["cash", "card", "transfer"];

const SESSION_FIELDS = `
  s.id, s.table_id, s.tariff_id, s.price_per_hour_snapshot,
  s.started_at, s.ended_at, s.total_cost_kopecks,
  s.payment_method, s.client_id, s.discount_percent,
  s.time_cost_kopecks, s.bar_cost_kopecks, s.is_free,
  s.prepaid_seconds, s.prepaid_kopecks, s.prepaid_mode,
  s.voucher_kopecks, s.voucher_id, s.promo_name, s.account_kopecks,
  t.name AS table_name, tr.name AS tariff_name,
  uo.name AS opened_by_name, uc.name AS closed_by_name,
  cl.name AS client_name, vch.code AS voucher_code,
  (SELECT COALESCE(SUM(v.balance_kopecks), 0) FROM vouchers v
    WHERE v.client_id = s.client_id AND v.kind = 'topup' AND v.status = 'active')
    AS client_account_kopecks
`;

const SESSION_JOIN = `
  FROM table_sessions s
  JOIN tables t ON t.id = s.table_id
  JOIN tariffs tr ON tr.id = s.tariff_id
  LEFT JOIN users uo ON uo.id = s.opened_by
  LEFT JOIN users uc ON uc.id = s.closed_by
  LEFT JOIN clients cl ON cl.id = s.client_id
  LEFT JOIN vouchers vch ON vch.id = s.voucher_id
`;

/** Сумма бара по сеансу, в копейках (локально — во избежание циклов импортов). */
function barTotalKopecks(db, sessionId) {
  return db
    .prepare(
      "SELECT COALESCE(SUM(price_kopecks * quantity), 0) AS total FROM session_orders WHERE session_id = ?"
    )
    .get(sessionId).total;
}

/**
 * Расчёт чека сеанса на момент endIso: время (с учётом минимального
 * оплачиваемого времени), скидка клиента, бар, округление итога.
 * Всё в копейках; используется и для предпросмотра, и при закрытии.
 */
export function computeCheck(db, session, endIso) {
  const club = getClubSettings(db);
  // Деньги со счёта клиента. Уже потраченное при открытии лежит в
  // account_kopecks; доступный остаток счёта нужен, чтобы показать
  // кассиру, сколько из доплаты уйдёт со счёта, а сколько взять деньгами.
  const spentFromAccount = session.account_kopecks ?? 0;
  const accountLeft = clientAccountKopecks(db, session.client_id ?? null);
  /**
   * Разносит итоговые суммы чека по источникам: что берём со счёта,
   * что деньгами, и какую сдачу нельзя выдавать из кассы.
   */
  const splitAccount = (dueKopecks, changeKopecks = 0) => {
    const dueFromAccount = Math.min(accountLeft, dueKopecks);
    // Сдачу за время, оплаченное со счёта, в кассе брать неоткуда —
    // она возвращается обратно на счёт клиента.
    const changeToAccount = Math.min(changeKopecks, spentFromAccount);
    return {
      paid_from_account_kopecks: spentFromAccount,
      account_left_kopecks: accountLeft,
      due_from_account_kopecks: dueFromAccount,
      due_money_kopecks: dueKopecks - dueFromAccount,
      change_to_account_kopecks: changeToAccount,
      change_kopecks: changeKopecks - changeToAccount,
    };
  };
  const rawSeconds = Math.max(
    0,
    Math.floor((Date.parse(endIso) - Date.parse(session.started_at)) / 1000)
  );
  const barCost = barTotalKopecks(db, session.id);

  // Бесплатное время: время не тарифицируется, бар — как обычно.
  if (session.is_free) {
    return {
      duration_seconds: rawSeconds,
      billed_seconds: rawSeconds,
      time_cost_kopecks: 0,
      discount_percent: session.discount_percent ?? 0,
      discounted_time_kopecks: 0,
      bar_cost_kopecks: barCost,
      total_kopecks: barCost,
      prepaid: false,
      free: true,
      prepaid_kopecks: 0,
      prepaid_seconds: null,
      prepaid_mode: null,
      voucher_kopecks: 0,
      voucher_code: null,
      due_kopecks: barCost,
      ...splitAccount(barCost),
      voucher_out_kopecks: 0,
      unused_seconds: 0,
      overtime_seconds: 0,
    };
  }

  const discount = session.discount_percent ?? 0;
  const billedSeconds = Math.max(rawSeconds, club.min_session_minutes * 60);
  const timeCost = costKopecks(session.price_per_hour_snapshot, billedSeconds);
  const discountedTime = applyDiscount(timeCost, discount);
  const total = roundToStep(discountedTime + barCost, club.rounding_step_kopecks);

  // Предоплата. Три случая, и они считаются по-разному:
  //
  // • «на время» (оплатил час) — платит за фактическое время, разницу
  //   возвращаем деньгами (сдача);
  // • «чек на сумму» — деньги остаются в клубе: неиспользованный
  //   остаток не возвращается, а выдаётся чеком на остаток;
  // • «по чеку» — играет за ранее оплаченные деньги: новой выручки нет,
  //   с гостя берём только бар и перебор по времени.
  if (session.prepaid_kopecks !== null && session.prepaid_kopecks !== undefined) {
    const paid = session.prepaid_kopecks;
    const paidSeconds = session.prepaid_seconds ?? 0;
    // Часть предоплаты, пришедшая чеком: эти деньги в выручку уже
    // попали в прошлый визит, второй раз их считать нельзя.
    const booked = session.voucher_kopecks ?? 0;
    const byTime = (session.prepaid_mode ?? "time") === "time";

    // Выручка визита: на время — по факту, иначе клуб оставляет всё
    // полученное (но не меньше стоимости фактического времени).
    const revenueBeforeBar = byTime ? discountedTime : Math.max(paid, discountedTime);
    const revenue = roundToStep(
      Math.max(0, revenueBeforeBar + barCost - booked),
      club.rounding_step_kopecks
    );
    // Живые деньги, уже полученные по этому сеансу (без чековой части).
    const cashPaid = Math.max(0, paid - booked);
    const unusedKopecks = Math.max(0, paid - discountedTime);

    return {
      duration_seconds: rawSeconds,
      billed_seconds: billedSeconds,
      time_cost_kopecks: timeCost,
      discount_percent: discount,
      discounted_time_kopecks: discountedTime,
      bar_cost_kopecks: barCost,
      total_kopecks: revenue,
      prepaid: true,
      free: false,
      prepaid_kopecks: paid,
      prepaid_seconds: paidSeconds,
      prepaid_mode: session.prepaid_mode ?? "time",
      voucher_kopecks: booked,
      voucher_code: session.voucher_code ?? null,
      // Что происходит в кассе при закрытии.
      due_kopecks: Math.max(0, revenue - cashPaid),
      // Сдача деньгами — только для «на время».
      ...splitAccount(
        Math.max(0, revenue - cashPaid),
        byTime ? Math.max(0, cashPaid - revenue) : 0
      ),
      // Остаток чеком — для «чека на сумму» и игры «по чеку».
      voucher_out_kopecks: byTime ? 0 : unusedKopecks,
      unused_seconds: Math.max(0, paidSeconds - billedSeconds),
      overtime_seconds: Math.max(0, billedSeconds - paidSeconds),
    };
  }

  return {
    duration_seconds: rawSeconds,
    billed_seconds: billedSeconds,
    time_cost_kopecks: timeCost,
    discount_percent: discount,
    discounted_time_kopecks: discountedTime,
    bar_cost_kopecks: barCost,
    total_kopecks: total,
    prepaid: false,
    free: false,
    prepaid_kopecks: 0,
    prepaid_seconds: null,
    prepaid_mode: null,
    voucher_kopecks: 0,
    voucher_code: null,
    due_kopecks: total,
    ...splitAccount(total),
    voucher_out_kopecks: 0,
    unused_seconds: 0,
    overtime_seconds: 0,
  };
}

/**
 * Открытый сеанс стола, если есть.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 */
export function getOpenSession(db, tableId) {
  return db
    .prepare(
      `SELECT ${SESSION_FIELDS} ${SESSION_JOIN}
       WHERE s.table_id = ? AND s.ended_at IS NULL`
    )
    .get(tableId);
}

function getSession(db, sessionId) {
  return db
    .prepare(`SELECT ${SESSION_FIELDS} ${SESSION_JOIN} WHERE s.id = ?`)
    .get(sessionId);
}

/**
 * Открывает сеанс: стол занят, свет включён, событие в журнале.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {number | null} tariffId тариф; null — взять тариф, назначенный
 *   столу администратором (кассир тариф не выбирает, он открывает время)
 * @param {{id: number, name: string, role: string}} user кто открывает
 * @param {{clientId?: number | null,
 *          prepaidSeconds?: number | null,
 *          prepaidAmount?: number | null,
 *          paymentMethod?: string | null,
 *          isFree?: boolean}} [options]
 *   clientId — клиент (его скидка фиксируется снимком на весь сеанс);
 *   prepaidSeconds — предоплата «на время»: оплаченные секунды;
 *   prepaidAmount — предоплата «на сумму»: рубли, время считается по
 *   тарифу со скидкой; paymentMethod обязателен для предоплаты;
 *   isFree — бесплатное время (время не тарифицируется, бар — как обычно);
 *   право на это проверяется в роуте, здесь только сама механика;
 *   useBalance — сначала списать предоплату со счёта клиента (по умолчанию
 *   да; кассир может снять галочку, если гость хочет заплатить деньгами).
 */
export function openSession(
  db,
  tableId,
  tariffId,
  user,
  {
    clientId = null,
    prepaidSeconds = null,
    prepaidAmount = null,
    voucherCode = null,
    paymentMethod = null,
    isFree = false,
    useBalance = true,
  } = {}
) {
  const table = getTable(db, tableId);
  const club = getClubSettings(db);
  // Тариф не передали — берём тот, что назначен столу: кассир открывает
  // время, а цену стола задаёт администратор.
  const effectiveTariffId =
    tariffId ??
    resolveTableTariffId(db, table.id, resolveTariffId(db, club.tz_offset_minutes));
  if (effectiveTariffId === null || effectiveTariffId === undefined) {
    throw new ConflictError(
      `Столу «${table.name}» не назначен тариф — задайте его в «Зоны и тарифы»`
    );
  }
  const tariff = getTariff(db, effectiveTariffId);
  if (!tariff.is_active) {
    throw new ConflictError(`Тариф «${tariff.name}» отключён`);
  }
  const allowedTariffIds = getAllowedTariffIds(db, table.id);
  if (allowedTariffIds.length > 0 && !allowedTariffIds.includes(tariff.id)) {
    throw new ConflictError(
      `На столе «${table.name}» этот тариф не разрешён — выберите из допустимых для стола`
    );
  }
  if (table.status !== "free" || getOpenSession(db, table.id)) {
    throw new ConflictError(`Стол «${table.name}» уже занят`);
  }
  const shiftId = requireShiftFor(db, user);
  const client = clientId ? getClient(db, clientId) : null;
  // Скидка клиента и акция «счастливый час» не складываются — берём
  // бо́льшую. Скидка фиксируется на весь сеанс: акция может кончиться
  // посреди игры, но цена для гостя меняться не должна.
  const promo = activePromotion(db, club.tz_offset_minutes);
  const clientDiscount = client?.discount_percent ?? 0;
  const promoDiscount = promo?.discount_percent ?? 0;
  const discount = Math.max(clientDiscount, promoDiscount);
  const promoName = promoDiscount > clientDiscount ? promo.name : null;

  // Предоплата: считаем оплаченное время и сумму. Бесплатное время
  // предоплату исключает — время и так ничего не стоит.
  //
  // prepaid.mode: time — оплатил час, amount — чек на сумму,
  // voucher — играет по ранее выданному чеку на остаток.
  let prepaid = null;
  let voucher = null;
  const wantsPrepaid =
    prepaidSeconds !== null || prepaidAmount !== null || voucherCode !== null;
  if (!isFree && wantsPrepaid) {
    // Эффективная цена часа с учётом скидки клиента, в копейках.
    const perHour = applyDiscount(tariff.price_per_hour * 100, discount);
    if (perHour <= 0) {
      throw new ConflictError("Цена со скидкой равна нулю — предоплата невозможна");
    }

    if (voucherCode !== null) {
      // Игра по чеку: новых денег не берём, способ оплаты не нужен.
      voucher = requireUsableVoucher(db, voucherCode);
      const kopecks = voucher.balance_kopecks;
      const seconds = Math.floor((kopecks * 3600) / perHour);
      if (seconds < 60) {
        throw new ConflictError(
          `На чеке ${voucher.code} осталось меньше минуты игры по этому тарифу`
        );
      }
      prepaid = { seconds, kopecks, mode: "voucher", voucherKopecks: kopecks };
    } else if (prepaidSeconds !== null) {
      const seconds = Number(prepaidSeconds);
      if (!Number.isInteger(seconds) || seconds < 15 * 60 || seconds > 24 * 3600) {
        throw new ConflictError("Оплаченное время: от 15 минут до 24 часов");
      }
      prepaid = {
        seconds,
        kopecks: roundToStep(
          applyDiscount(costKopecks(tariff.price_per_hour, seconds), discount),
          club.rounding_step_kopecks
        ),
        mode: "time",
        voucherKopecks: 0,
      };
    } else {
      const amount = Number(prepaidAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ConflictError("Сумма предоплаты должна быть больше нуля");
      }
      const kopecks = Math.round(amount * 100);
      const seconds = Math.floor((kopecks * 3600) / perHour);
      if (seconds < 5 * 60) {
        throw new ConflictError("Этой суммы хватает меньше чем на 5 минут");
      }
      prepaid = { seconds, kopecks, mode: "amount", voucherKopecks: 0 };
    }
  }

  // Сначала счёт клиента. Гость, который заранее внёс деньги, не должен
  // платить второй раз: предоплата берётся со счёта, а живыми деньгами
  // кассир добирает только разницу. Игру «по чеку» это не трогает —
  // там гость уже назвал код, каким платит.
  const fromAccount =
    prepaid && !voucher && useBalance && client
      ? Math.min(clientAccountKopecks(db, client.id), prepaid.kopecks)
      : 0;
  const moneyDue = prepaid && !voucher ? prepaid.kopecks - fromAccount : 0;
  if (moneyDue > 0 && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new ConflictError("Для предоплаты укажите способ оплаты");
  }

  const sessionId = withTransaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO table_sessions
           (table_id, tariff_id, price_per_hour_snapshot, started_at,
            opened_by, shift_id, client_id, discount_percent, promo_name,
            prepaid_seconds, prepaid_kopecks, prepaid_mode,
            voucher_kopecks, voucher_id, account_kopecks, payment_method, is_free)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        table.id,
        tariff.id,
        tariff.price_per_hour,
        utcNow(),
        user.id,
        shiftId,
        client?.id ?? null,
        discount,
        promoName,
        prepaid?.seconds ?? null,
        prepaid?.kopecks ?? null,
        prepaid?.mode ?? null,
        prepaid?.voucherKopecks ?? 0,
        voucher?.id ?? null,
        fromAccount,
        // По чеку живых денег нет — способ оплаты пишем «voucher»,
        // чтобы в отчётах такая игра не попала в наличные и карту.
        // Так же и со счётом клиента: «balance» — деньги в кассу пришли
        // при пополнении, второй раз их туда класть нельзя.
        prepaid ? (voucher ? "voucher" : moneyDue > 0 ? paymentMethod : "balance") : null,
        isFree ? 1 : 0
      );
    const newSessionId = Number(lastInsertRowid);
    db.prepare("UPDATE tables SET status = 'busy' WHERE id = ?").run(table.id);
    // Чек списывается сразу: его остаток ушёл в оплату этого сеанса.
    if (voucher) redeemVoucher(db, voucher.id, newSessionId);
    if (fromAccount > 0) {
      debitClientAccount(db, client.id, fromAccount, { sessionId: newSessionId, user });
    }
    const prepaidNote = prepaid
      ? (voucher
          ? `, по чеку ${voucher.code} на ` +
            `${kopecksToRubles(prepaid.kopecks).toFixed(2)} ${getClubSettings(db).currency}`
          : `, предоплата ${kopecksToRubles(prepaid.kopecks).toFixed(2)} ${getClubSettings(db).currency}`) +
        ` (${Math.round(prepaid.seconds / 60)} мин)`
      : "";
    logEvent(
      db,
      JournalEvent.SESSION_OPENED,
      `Открыт сеанс на столе «${table.name}», тариф «${tariff.name}» ` +
        `(${tariff.price_per_hour} ${getClubSettings(db).currency}/час)` +
        (client ? `, клиент «${client.name}»` : "") +
        (promoName ? `, акция «${promoName}» −${discount}%` : "") +
        prepaidNote +
        (isFree ? ", бесплатное время" : "") +
        ` — ${user.name}`,
      { tableId: table.id, sessionId: newSessionId }
    );
    if (fromAccount > 0) {
      logEvent(
        db,
        JournalEvent.SESSION_OPENED,
        `Со счёта клиента «${client.name}» списано ` +
          `${kopecksToRubles(fromAccount).toFixed(2)} ${getClubSettings(db).currency}` +
          (moneyDue > 0
            ? `, деньгами добрано ${kopecksToRubles(moneyDue).toFixed(2)}`
            : " — доплаты нет"),
        { tableId: table.id, sessionId: newSessionId }
      );
    }
    logEvent(db, JournalEvent.LIGHT_ON, `Включён свет над столом «${table.name}»`, {
      tableId: table.id,
      sessionId: newSessionId,
    });
    return newSessionId;
  });

  getLightingController().turnLightOn(table.id);
  return getSession(db, sessionId);
}

/**
 * Продление открытого предоплаченного сеанса: добавляет время («ещё 30
 * минут») или сумму («ещё на 5000»). Нужно, когда у гостя закончился
 * оплаченный час, а он хочет играть дальше — раньше приходилось закрывать
 * стол и открывать заново, теряя историю сеанса.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {{id: number, name: string, role: string}} user
 * @param {{minutes?: number | null, amount?: number | null,
 *          paymentMethod?: string | null}} options
 *   minutes — сколько минут добавить; amount — на какую сумму добавить
 *   времени (по тарифу сеанса со скидкой). Указывается одно из двух;
 *   useBalance — сначала списать со счёта клиента (по умолчанию да).
 */
export function extendSession(
  db,
  tableId,
  user,
  { minutes = null, amount = null, paymentMethod = null, useBalance = true } = {}
) {
  const table = getTable(db, tableId);
  const session = getOpenSession(db, table.id);
  if (!session) {
    throw new ConflictError(`Стол «${table.name}» свободен — продлевать нечего`);
  }
  if (session.is_free) {
    throw new ConflictError(
      "Это бесплатное время — оно не ограничено, продлевать нечего"
    );
  }
  if (session.prepaid_kopecks === null || session.prepaid_kopecks === undefined) {
    throw new ConflictError(
      "Сеанс без ограничения времени — время не кончится, продлевать не нужно"
    );
  }
  if ((minutes === null) === (amount === null)) {
    throw new ConflictError("Укажите либо минуты, либо сумму продления");
  }

  const club = getClubSettings(db);
  const discount = session.discount_percent ?? 0;
  const perHour = applyDiscount(session.price_per_hour_snapshot * 100, discount);
  if (perHour <= 0) {
    throw new ConflictError("Цена со скидкой равна нулю — продление невозможно");
  }

  let addSeconds;
  let addKopecks;
  if (minutes !== null) {
    const mins = Number(minutes);
    if (!Number.isInteger(mins) || mins < 5 || mins > 12 * 60) {
      throw new ConflictError("Продление: от 5 минут до 12 часов");
    }
    addSeconds = mins * 60;
    addKopecks = roundToStep(
      applyDiscount(costKopecks(session.price_per_hour_snapshot, addSeconds), discount),
      club.rounding_step_kopecks
    );
  } else {
    const sum = Number(amount);
    if (!Number.isFinite(sum) || sum <= 0) {
      throw new ConflictError("Сумма продления должна быть больше нуля");
    }
    addKopecks = Math.round(sum * 100);
    addSeconds = Math.floor((addKopecks * 3600) / perHour);
    if (addSeconds < 5 * 60) {
      throw new ConflictError("Этой суммы хватает меньше чем на 5 минут");
    }
  }

  const totalSeconds = (session.prepaid_seconds ?? 0) + addSeconds;
  if (totalSeconds > 24 * 3600) {
    throw new ConflictError("Всего оплаченного времени не может быть больше 24 часов");
  }

  // Продление гость тоже оплачивает сначала со счёта.
  const fromAccount = useBalance
    ? Math.min(clientAccountKopecks(db, session.client_id ?? null), addKopecks)
    : 0;
  const moneyDue = addKopecks - fromAccount;
  if (moneyDue > 0 && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new ConflictError("Укажите способ оплаты продления");
  }

  // Продление — тоже касса, поэтому смена нужна на тех же условиях.
  requireShiftFor(db, user);

  withTransaction(db, () => {
    db.prepare(
      `UPDATE table_sessions
         SET prepaid_seconds = ?, prepaid_kopecks = ?, payment_method = ?,
             account_kopecks = account_kopecks + ?
       WHERE id = ?`
    ).run(
      totalSeconds,
      session.prepaid_kopecks + addKopecks,
      // Если продление целиком ушло со счёта, способ оплаты сеанса не
      // трогаем: живых денег в кассу сейчас не поступило.
      moneyDue > 0 ? paymentMethod : session.payment_method,
      fromAccount,
      session.id
    );
    if (fromAccount > 0) {
      debitClientAccount(db, session.client_id, fromAccount, {
        sessionId: session.id,
        user,
      });
    }
    logEvent(
      db,
      JournalEvent.SESSION_OPENED,
      `Продлён сеанс на столе «${table.name}»: +${Math.round(addSeconds / 60)} мин ` +
        `за ${kopecksToRubles(addKopecks).toFixed(2)} ${club.currency}` +
        (fromAccount > 0
          ? `, со счёта клиента ${kopecksToRubles(fromAccount).toFixed(2)}`
          : "") +
        ` — ${user.name}`,
      { tableId: table.id, sessionId: session.id }
    );
  });

  return getSession(db, session.id);
}

/**
 * Пересаживает гостей на другой стол: сеанс со всей оплатой, баром,
 * клиентом и таймером переезжает целиком. Нужно, когда стол сломался
 * или гости попросили другой — раньше приходилось закрывать сеанс и
 * открывать новый, теряя оплаченное время и историю.
 *
 * Тариф остаётся прежним (по нему уже посчитана предоплата), поэтому
 * цена от пересадки не меняется — это важно, чтобы гость не получил
 * неожиданный счёт.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId откуда пересаживаем
 * @param {{id: number, name: string, role: string}} user
 * @param {{targetTableId?: number | null}} options куда пересаживаем
 */
export function moveSession(db, tableId, user, { targetTableId = null } = {}) {
  const from = getTable(db, tableId);
  const session = getOpenSession(db, from.id);
  if (!session) {
    throw new ConflictError(`Стол «${from.name}» свободен — пересаживать некого`);
  }
  if (!targetTableId) {
    throw new ConflictError("Выберите стол, на который пересадить");
  }
  const to = getTable(db, Number(targetTableId));
  if (to.id === from.id) {
    throw new ConflictError("Это тот же самый стол");
  }
  if (getOpenSession(db, to.id)) {
    throw new ConflictError(`Стол «${to.name}» занят — сначала освободите его`);
  }

  withTransaction(db, () => {
    db.prepare("UPDATE table_sessions SET table_id = ? WHERE id = ?").run(
      to.id,
      session.id
    );
    db.prepare("UPDATE tables SET status = 'free' WHERE id = ?").run(from.id);
    db.prepare("UPDATE tables SET status = 'busy' WHERE id = ?").run(to.id);
    logEvent(
      db,
      JournalEvent.SESSION_OPENED,
      `Гости пересажены со стола «${from.name}» на «${to.name}» — ${user.name}`,
      { tableId: to.id, sessionId: session.id }
    );
    logEvent(db, JournalEvent.LIGHT_OFF, `Выключен свет над столом «${from.name}»`, {
      tableId: from.id,
      sessionId: session.id,
    });
    logEvent(db, JournalEvent.LIGHT_ON, `Включён свет над столом «${to.name}»`, {
      tableId: to.id,
      sessionId: session.id,
    });
  });

  const lighting = getLightingController();
  lighting.turnLightOff(from.id);
  lighting.turnLightOn(to.id);
  return getSession(db, session.id);
}

/**
 * Закрывает сеанс: считает стоимость, освобождает стол, гасит свет.
 * Выручка привязывается к открытой смене закрывающего сотрудника.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} tableId
 * @param {{id: number, name: string, role: string}} user кто закрывает
 * @param {{paymentMethod?: string | null}} [options] способ оплаты
 *   (cash | card | transfer); по умолчанию — способ, выбранный при
 *   предоплате, иначе cash
 */
/**
 * Акция «каждый N-й час в подарок». Считает, сколько часов клиент уже
 * наиграл, и если он перешагнул очередной рубеж — выдаёт подарочный чек
 * на эти часы по цене текущего тарифа.
 *
 * Подарок оформлен именно чеком, а не «бесплатным временем»: у него
 * есть код, срок жизни и след в отчётах, а деньги за него в кассу не
 * приходили — в выручке он не считается (см. vouchers.js).
 *
 * @returns {object | null} выданный чек или null
 */
function awardBonusHours(db, session, user) {
  const everyHours = Number(getSettings(db).bonus_every_hours ?? 0);
  if (!everyHours || !session.client_id) return null;

  const played = db
    .prepare(
      `SELECT COALESCE(SUM(
                CAST(strftime('%s', ended_at) AS INTEGER)
                - CAST(strftime('%s', started_at) AS INTEGER)), 0) AS seconds
       FROM table_sessions
       WHERE client_id = ? AND ended_at IS NOT NULL`
    )
    .get(session.client_id).seconds;
  const hours = Math.floor(played / 3600);
  const deserved = Math.floor(hours / everyHours);
  const awarded = db
    .prepare("SELECT bonus_hours_awarded FROM clients WHERE id = ?")
    .get(session.client_id).bonus_hours_awarded;
  const owed = deserved - awarded;
  if (owed <= 0) return null;

  const amountKopecks = owed * session.price_per_hour_snapshot * 100;
  if (amountKopecks <= 0) return null;
  const voucher = createVoucher(db, {
    amountKopecks,
    clientId: session.client_id,
    sourceSessionId: session.id,
    user,
    kind: "bonus",
  });
  db.prepare("UPDATE clients SET bonus_hours_awarded = ? WHERE id = ?").run(
    deserved,
    session.client_id
  );
  logEvent(
    db,
    JournalEvent.SESSION_CLOSED,
    `Подарок за ${hours} ч игры: чек ${voucher.code} на ${owed} ч ` +
      `(акция «каждый ${everyHours}-й час в подарок»)`,
    { sessionId: session.id }
  );
  return { ...voucher, bonus_hours: owed };
}

export function closeSession(
  db,
  tableId,
  user,
  { paymentMethod = null, useBalance = true } = {}
) {
  const table = getTable(db, tableId);
  const session = getOpenSession(db, table.id);
  if (!session) {
    throw new ConflictError(`Стол «${table.name}» свободен — закрывать нечего`);
  }
  const endedAt = utcNow();
  const check = computeCheck(db, session, endedAt);

  // Доплату тоже сначала берём со счёта клиента: гость, положивший
  // деньги заранее, не должен доставать кошелёк за перебор по времени
  // или за бар. Деньгами кассир добирает только то, чего не хватило.
  const paidFromAccount = useBalance ? check.due_from_account_kopecks : 0;
  const moneyDue = check.due_kopecks - paidFromAccount;

  // Сдача за недоигранное время, оплаченное со счёта, из кассы не
  // выдаётся: этих денег в ящике нет, они пришли при пополнении. Такая
  // сдача возвращается обратно на счёт клиента.
  const refundToAccount = check.change_to_account_kopecks;
  // Сколько со счёта клиента ушло в выручку этого сеанса.
  const accountKopecks =
    check.paid_from_account_kopecks - refundToAccount + paidFromAccount;

  // Способ оплаты нужен, только если с гостя ещё берут деньги. Игра по
  // чеку без доплаты так и остаётся «voucher» — в наличные и карту она
  // не попадёт, эти деньги в кассу пришли раньше.
  if (moneyDue > 0) {
    paymentMethod = paymentMethod ?? session.payment_method ?? "cash";
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new ConflictError(
        `Недопустимый способ оплаты «${paymentMethod}» (cash, card или transfer)`
      );
    }
  } else if (accountKopecks > 0 && accountKopecks >= check.total_kopecks) {
    // Весь сеанс оплачен со счёта — в наличные и карту он не попадёт.
    paymentMethod = "balance";
  } else {
    // Живых денег сейчас не берём. «voucher» сохраняем — эти деньги
    // пришли раньше по чеку. А «balance» здесь не годится: часть сеанса
    // всё-таки оплачена деньгами, и она должна попасть в кассу.
    paymentMethod =
      session.payment_method === "voucher"
        ? "voucher"
        : paymentMethod ??
          (PAYMENT_METHODS.includes(session.payment_method)
            ? session.payment_method
            : "cash");
    if (
      paymentMethod !== "voucher" &&
      !PAYMENT_METHODS.includes(paymentMethod)
    ) {
      throw new ConflictError(
        `Недопустимый способ оплаты «${paymentMethod}» (cash, card или transfer)`
      );
    }
  }
  const closeShiftId = requireShiftFor(db, user);

  let issuedVoucher = null;
  let bonusVoucher = null;
  // true — остаток вернулся на прежний чек, а не выдан новый код. Кассиру
  // это надо сказать другими словами, иначе он продиктует гостю «новый»
  // код, который на самом деле тот же.
  let reusedVoucher = false;

  withTransaction(db, () => {
    db.prepare(
      `UPDATE table_sessions SET ended_at = ?, total_cost_kopecks = ?,
         time_cost_kopecks = ?, bar_cost_kopecks = ?, payment_method = ?,
         account_kopecks = ?, closed_by = ?, close_shift_id = ? WHERE id = ?`
    ).run(
      endedAt,
      check.total_kopecks,
      check.time_cost_kopecks,
      check.bar_cost_kopecks,
      paymentMethod,
      accountKopecks,
      user.id,
      closeShiftId,
      session.id
    );
    db.prepare("UPDATE tables SET status = 'free' WHERE id = ?").run(table.id);
    if (paidFromAccount > 0) {
      debitClientAccount(db, session.client_id, paidFromAccount, {
        sessionId: session.id,
        user,
      });
    }
    if (refundToAccount > 0) {
      creditClientAccount(db, session.client_id, refundToAccount, { user });
    }

    // Неиспользованный остаток чека на сумму не возвращаем деньгами —
    // выдаём чек, по которому гость доиграет в другой день. Если гость
    // и так играл по чеку, остаток возвращается на ТОТ ЖЕ код: гостю не
    // приходится запоминать новый номер после каждого недоигранного раза.
    if (check.voucher_out_kopecks > 0) {
      if (session.voucher_id) {
        try {
          issuedVoucher = reissueVoucher(db, session.voucher_id, check.voucher_out_kopecks, {
            user,
          });
          reusedVoucher = true;
        } catch {
          // Чек успели отменить, пока гость играл — деньги гостя не
          // теряем, выдаём новый. Закрытие стола падать не должно.
          issuedVoucher = null;
        }
      }
      if (!issuedVoucher) {
        issuedVoucher = createVoucher(db, {
          amountKopecks: check.voucher_out_kopecks,
          clientId: session.client_id ?? null,
          sourceSessionId: session.id,
          user,
        });
      }
    }

    // Подарочные часы считаем после того, как сеанс закрыт: его время
    // тоже идёт в зачёт.
    bonusVoucher = awardBonusHours(db, session, user);

    const methodLabel =
      { cash: "наличные", card: "карта", transfer: "перевод", balance: "со счёта клиента" }[
        paymentMethod
      ] ?? "по чеку";
    logEvent(
      db,
      JournalEvent.SESSION_CLOSED,
      `Закрыт сеанс на столе «${table.name}», итог ` +
        `${kopecksToRubles(check.total_kopecks).toFixed(2)} ${getClubSettings(db).currency} (${methodLabel}) — ${user.name}`,
      { tableId: table.id, sessionId: session.id }
    );
    logEvent(db, JournalEvent.LIGHT_OFF, `Выключен свет над столом «${table.name}»`, {
      tableId: table.id,
      sessionId: session.id,
    });
  });

  getLightingController().turnLightOff(table.id);
  const closed = getSession(db, session.id);
  // Выданный чек отдаём вызывающему: его код нужно показать кассиру и
  // напечатать на чеке.
  return {
    ...closed,
    issued_voucher: issuedVoucher ?? null,
    // Остаток вернулся на прежний чек — код у гостя не поменялся.
    reused_voucher: reusedVoucher,
    // Сколько ушло со счёта клиента и сколько вернулось на счёт.
    paid_from_account: kopecksToRubles(accountKopecks),
    refunded_to_account: kopecksToRubles(refundToAccount),
    bonus_voucher: bonusVoucher ?? null,
  };
}

/**
 * Текущая стоимость сеанса в копейках: для закрытого — сохранённый итог,
 * для открытого — полный чек (время со скидкой + бар) на «сейчас».
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} session строка table_sessions
 */
export function currentCostKopecks(db, session) {
  if (session.total_cost_kopecks !== null && session.total_cost_kopecks !== undefined) {
    return session.total_cost_kopecks;
  }
  return computeCheck(db, session, utcNow()).total_kopecks;
}

/**
 * Сеанс по id (для чека) — с полями стола, тарифа, кассиров и клиента.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function getSessionById(db, sessionId) {
  const session = db
    .prepare(`SELECT ${SESSION_FIELDS} ${SESSION_JOIN} WHERE s.id = ?`)
    .get(sessionId);
  if (!session) {
    throw new NotFoundError(`Сеанс id=${sessionId} не найден`);
  }
  return session;
}

/**
 * Закрытые сеансы, новые сверху.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} [limit]
 */
export function listHistory(db, limit = 100) {
  return db
    .prepare(
      `SELECT ${SESSION_FIELDS} ${SESSION_JOIN}
       WHERE s.ended_at IS NOT NULL
       ORDER BY s.ended_at DESC LIMIT ?`
    )
    .all(limit);
}
