// HTTP API. Здесь только разбор запросов и формирование ответов —
// вся бизнес-логика в сервисах.

import { Router } from "express";

import {
  clearedSessionCookie,
  createAuthSession,
  deleteAuthSession,
  sessionCookie,
} from "../services/auth.js";
import { kopecksToRubles } from "../services/billing.js";
import { ConflictError, ForbiddenError } from "../services/errors.js";
import { JournalEvent, listJournal, logEvent } from "../services/journal.js";
import {
  getActiveDriver,
  syncLighting,
  getLightingController,
  initLighting,
  listCloudDevices,
  probeRelays,
  relayOnline,
} from "../services/lighting.js";
import {
  backupFileName,
  exportBackupFile,
  importBackupFile,
} from "../services/backup.js";
import {
  listBookings,
  cancelBooking,
  createBooking,
  endsAtIso,
  nextBookingForTable,
} from "../services/bookings.js";
import { clientStats, createClient, listClients, updateClient } from "../services/clients.js";
import { createMenuItem, deleteMenuItem, listMenu, updateMenuItem } from "../services/menu.js";
import { addOrder, listOrders, removeOrder } from "../services/orders.js";
import {
  backupDir,
  keepBackups,
  listBackups,
  makeBackupNow,
} from "../services/auto-backup.js";
import { diagnostics, isServerStale } from "../services/diagnostics.js";
import {
  clearDemoData,
  demoDataPresent,
  fillDemoData,
} from "../services/demo-data.js";
import {
  configFileName,
  exportConfig,
  importConfig,
} from "../services/config-transfer.js";
import { checkupData, fixData } from "../services/doctor.js";
import {
  createDevice,
  deleteDevice,
  listDevices,
  setDeviceCycle,
  setDevicePosition,
  setDevicePower,
  updateDevice,
} from "../services/devices.js";
import { describeSchema, runReadOnlyQuery } from "../services/sql-console.js";
import { networkMode, RESTART_EXIT_CODE } from "../config.js";
import { clearRequests, recentRequests } from "../services/request-log.js";
import { buildSupportReport, supportReportFileName } from "../services/support.js";
import { networkInfo } from "../services/network.js";
import { getPlan, savePlan } from "../services/plan.js";
import {
  cancelVoucher,
  findVoucherByCode,
  listVouchers,
  topUpClient,
  voucherToOut,
} from "../services/vouchers.js";
import {
  getPermissionMatrix,
  getUserPermissionOverrides,
  permissionsForUser,
  setPermissions,
  setUserPermissionOverrides,
  userCan,
} from "../services/permissions.js";
import { getClubSettings, getSettings, saveSettings } from "../services/settings.js";
import {
  closeSession,
  computeCheck,
  currentCostKopecks,
  extendSession,
  moveSession,
  getOpenSession,
  getSessionById,
  listHistory,
  openSession,
} from "../services/sessions.js";
import {
  addCashMovement,
  closeShift,
  currentShift,
  listCashMovements,
  listShifts,
  openShift,
} from "../services/shifts.js";
import { overview, revenueReport, tableLoad } from "../services/stats.js";
import { payrollReport } from "../services/payroll.js";
import { checkSubscriptionNow } from "../services/subscription.js";
import {
  remindUpcomingBookings,
  sendTelegramTest,
  telegramConfig,
} from "../services/telegram.js";
import {
  activePromotion,
  createPromotion,
  deletePromotion,
  listPromotions,
  setPromotionActive,
} from "../services/promotions.js";
import { createRule, deleteRule, listRules, resolveTariffId } from "../services/tariff-rules.js";
import {
  createTable,
  deleteTable,
  getAllowedTariffIds,
  listTables,
  resolveTableTariffId,
  setAllowedTariffIds,
  setTableDevice,
  setTableLayout,
} from "../services/tables.js";
import {
  createTariff,
  deleteTariff,
  getTariff,
  listTariffs,
  updateTariff,
} from "../services/tariffs.js";
import {
  authenticate,
  changeOwnPassword,
  createUser,
  deleteUser,
  getUser,
  isOwnerSetupPending,
  listUsers,
  updateUser,
} from "../services/users.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PORT } from "../config.js";
import { utcNow } from "../db.js";
import { sessionToOut } from "./mappers.js";

/**
 * Пропускает только пользователя с данным правом (developer — всегда).
 * Учитывает личные ограничения сотрудника: они сильнее прав роли.
 */
function requirePermission(db, req, key) {
  if (req.user?.role === "developer") return;
  if (!userCan(db, req.user, key)) {
    throw new ForbiddenError("Недостаточно прав для этого действия");
  }
}

/** Настоящий владелец или разработчик. */
function isOwnerRole(req) {
  return ["developer", "owner"].includes(req.user?.role);
}

/**
 * Владельческие действия (редактор прав, загрузка базы из копии) — жёстко
 * по роли, в обход матрицы прав: иначе администратор мог бы сам себе
 * выдать владельческие полномочия.
 *
 * Исключение — свежая установка, где владельца и разработчика ещё нет:
 * тогда эти действия доступны тому, кто управляет сотрудниками. Без него
 * получался замкнутый круг: владельца не создать (роль спрятана) и права
 * не настроить (доступ только у владельца). Как только владелец появился,
 * доступ снова только у него.
 * @param {import("node:sqlite").DatabaseSync} db
 */
function ownerLevel(db, req) {
  if (isOwnerRole(req)) return;
  if (isOwnerSetupPending(db) && userCan(db, req.user, "manage_users")) {
    return;
  }
  throw new ForbiddenError("Доступно только владельцу или разработчику");
}

/**
 * Только разработчик. Отдельно от ownerLevel: демо-данные и SQL-консоль
 * владельцу клуба не нужны, а навредить ими можно.
 */
function requireDeveloper(req) {
  if (req.user?.role !== "developer") {
    throw new ForbiddenError("Доступно только разработчику");
  }
}

/**
 * Действия, которые касаются всего сервера, а не одного клуба:
 * перезапуск, адреса машины, общий журнал внутренних ошибок.
 *
 * В облачной версии один сервер обслуживает всю сеть, поэтому такие
 * действия закрыты даже разработчику клуба: перезапуск уронил бы работу
 * соседних клубов, а общий журнал ошибок показал бы их адреса и данные.
 */
function requireOwnServer() {
  if (networkMode()) {
    throw new ForbiddenError(
      "В облачной версии это делает поддержка WesPro: сервер общий для всей сети"
    );
  }
}

/** Целое число из параметра пути; иначе 404 через NotFound-подобный ответ. */
function intParam(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** То же правило, что в ownerLevel, но как проверка без исключения. */
function ownerLevelAllowed(db, user) {
  if (["developer", "owner"].includes(user?.role)) return true;
  return isOwnerSetupPending(db) && userCan(db, user, "manage_users");
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function createApiRouter(db) {
  const router = Router();

  // --- Авторизация ---------------------------------------------------------

  // Название и логотип клуба для страницы входа — до авторизации
  // (см. список открытых путей в app.js). Ничего чувствительного здесь нет.
  router.get("/brand", (req, res) => {
    const club = getClubSettings(db);
    res.json({
      club_name: club.club_name,
      club_logo: club.club_logo,
      club_logo_height: club.club_logo_height,
    });
  });

  router.post("/auth/login", (req, res) => {
    const user = authenticate(db, req.body?.login, req.body?.password);
    if (!user) {
      return res.status(401).json({ detail: "Неверный логин или пароль" });
    }
    const token = createAuthSession(db, user.id);
    res.setHeader("Set-Cookie", sessionCookie(token));
    const club = getClubSettings(db);
    res.json({
      user,
      shift: currentShift(db, user.id),
      club_name: club.club_name,
      club_logo: club.club_logo,
      club_logo_height: club.club_logo_height,
      currency: club.currency,
      warn_before_minutes: club.warn_before_minutes,
      warn_sound: club.warn_sound,
      receipt_width: club.receipt_width,
      permissions: permissionsForUser(db, user),
      owner_level: ownerLevelAllowed(db, user),
      owner_setup_pending: isOwnerSetupPending(db),
    });
  });

  router.post("/auth/logout", (req, res) => {
    deleteAuthSession(db, req.authToken);
    res.setHeader("Set-Cookie", clearedSessionCookie());
    res.json({ ok: true });
  });

  router.get("/auth/me", (req, res) => {
    const club = getClubSettings(db);
    res.json({
      user: req.user,
      shift: currentShift(db, req.user.id),
      club_name: club.club_name,
      club_logo: club.club_logo,
      club_logo_height: club.club_logo_height,
      currency: club.currency,
      warn_before_minutes: club.warn_before_minutes,
      warn_sound: club.warn_sound,
      receipt_width: club.receipt_width,
      permissions: permissionsForUser(db, req.user),
      // Кому показывать владельческие блоки: редактор прав, роли
      // «Владелец»/«Разработчик», загрузку базы из копии.
      owner_level: ownerLevelAllowed(db, req.user),
      owner_setup_pending: isOwnerSetupPending(db),
      // Программу обновили, а сервер работает на старом коде — страница
      // предупредит об этом сразу, не дожидаясь загадочных 404 и 500.
      restart_required: isServerStale(),
    });
  });

  router.post("/auth/password", (req, res) => {
    changeOwnPassword(
      db,
      req.user.id,
      req.body?.old_password,
      req.body?.new_password
    );
    res.json({ ok: true });
  });

  // --- Сотрудники ------------------------------------------------------------

  router.get("/users", (req, res) => {
    requirePermission(db, req, "manage_users");
    res.json(listUsers(db));
  });

  router.post("/users", (req, res) => {
    requirePermission(db, req, "manage_users");
    res.status(201).json(createUser(db, req.body ?? {}, req.user));
  });

  router.put("/users/:id", (req, res) => {
    requirePermission(db, req, "manage_users");
    const userId = intParam(req.params.id);
    if (userId === null) {
      return res.status(404).json({ detail: "Сотрудник не найден" });
    }
    res.json(updateUser(db, userId, req.body ?? {}, req.user));
  });

  // Личные ограничения сотрудника: перебивают права его роли.
  router.get("/users/:id/permissions", (req, res) => {
    requirePermission(db, req, "manage_users");
    const userId = intParam(req.params.id);
    if (userId === null) {
      return res.status(404).json({ detail: "Сотрудник не найден" });
    }
    res.json(getUserPermissionOverrides(db, getUser(db, userId)));
  });

  router.put("/users/:id/permissions", (req, res) => {
    requirePermission(db, req, "manage_users");
    const userId = intParam(req.params.id);
    if (userId === null) {
      return res.status(404).json({ detail: "Сотрудник не найден" });
    }
    const target = getUser(db, userId);
    // Себе права не урезаем: иначе можно случайно закрыть себе доступ и
    // остаться без возможности вернуть его через интерфейс.
    if (target.id === req.user.id) {
      throw new ConflictError(
        "Нельзя менять личные ограничения собственного аккаунта"
      );
    }
    // Управленческие роли настраивает только владелец/разработчик — иначе
    // администратор мог бы урезать владельца.
    if (["developer", "owner", "manager"].includes(target.role) && !isOwnerRole(req)) {
      throw new ForbiddenError(
        "Ограничения владельца, управляющего и разработчика меняет только владелец"
      );
    }
    const saved = setUserPermissionOverrides(db, target, req.body?.permissions ?? {});
    logEvent(
      db,
      JournalEvent.USER_UPDATED,
      `Изменены личные ограничения сотрудника «${target.name}» (${target.login})` +
        ` — ${req.user.name}`
    );
    res.json(saved);
  });

  router.delete("/users/:id", (req, res) => {
    requirePermission(db, req, "manage_users");
    const userId = intParam(req.params.id);
    if (userId === null) {
      return res.status(404).json({ detail: "Сотрудник не найден" });
    }
    res.json(deleteUser(db, userId, req.user));
  });

  // --- Кассовые смены ------------------------------------------------------

  router.get("/shifts/current", (req, res) => {
    res.json(currentShift(db, req.user.id));
  });

  router.post("/shifts/open", (req, res) => {
    const openingCash =
      req.body?.opening_cash === undefined || req.body?.opening_cash === null
        ? null
        : Number(req.body.opening_cash);
    res.status(201).json(openShift(db, req.user, { openingCash }));
  });

  router.post("/shifts/close", (req, res) => {
    const closingCash =
      req.body?.closing_cash === undefined || req.body?.closing_cash === null
        ? null
        : Number(req.body.closing_cash);
    res.json(closeShift(db, req.user, { closingCash }));
  });

  // Выдача из кассы и внесение в кассу: закупка, инкассация, размен.
  router.post("/shifts/cash", (req, res) => {
    const body = req.body ?? {};
    res.status(201).json(
      addCashMovement(db, req.user, {
        kind: body.kind ?? "out",
        amount: body.amount,
        reason: body.reason,
      })
    );
  });

  // Движение денег: по своей открытой смене — всегда, по чужой — только
  // тому, кто вообще видит чужие смены.
  router.get("/shifts/:id/cash", (req, res) => {
    const shiftId = intParam(req.params.id);
    if (shiftId === null) return res.status(404).json({ detail: "Смена не найдена" });
    const own = listShifts(db, { userId: req.user.id, limit: 1000 }).some(
      (s) => s.id === shiftId
    );
    const canViewAll =
      req.user.role === "developer" || userCan(db, req.user, "view_shifts");
    if (!own && !canViewAll) {
      return res.status(403).json({ detail: "Нет доступа к этой смене" });
    }
    res.json(listCashMovements(db, shiftId));
  });

  // Видит все смены только тот, у кого есть view_shifts — иначе только свои.
  router.get("/shifts", (req, res) => {
    const limit = clampLimit(req.query.limit, 100, 1000);
    const canViewAll =
      req.user.role === "developer" || userCan(db, req.user, "view_shifts");
    // Кто угодно выбрать себе может, только свою смену видит; выбор
    // кассира в фильтре имеет смысл только тем, кому открыты все смены.
    const userId = canViewAll
      ? req.query.user_id
        ? intParam(req.query.user_id)
        : undefined
      : req.user.id;
    res.json(
      listShifts(db, {
        userId,
        dateFrom: req.query.date_from ? String(req.query.date_from) : null,
        dateTo: req.query.date_to ? String(req.query.date_to) : null,
        limit,
      })
    );
  });

  // --- Отчёты ------------------------------------------------------------

  router.get("/stats/tables", (req, res) => {
    requirePermission(db, req, "view_reports");
    const days = clampLimit(req.query.days, 30, 365);
    res.json({ days, tables: tableLoad(db, days) });
  });

  // --- Столы -------------------------------------------------------------

  router.get("/tables", (req, res) => {
    res.json(listTables(db));
  });

  router.post("/tables", (req, res) => {
    requirePermission(db, req, "manage_tables");
    if (typeof req.body?.name !== "string") {
      throw new ConflictError("Поле name обязательно и должно быть строкой");
    }
    res.status(201).json(createTable(db, req.body.name, req.body?.kind ?? "billiard"));
  });

  router.delete("/tables/:id", (req, res) => {
    requirePermission(db, req, "manage_tables");
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    res.json(deleteTable(db, tableId));
  });

  // Разрешённые тарифы для стола: пусто — можно выбрать любой активный.
  router.get("/tables/:id/tariffs", (req, res) => {
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    res.json({ tariff_ids: getAllowedTariffIds(db, tableId) });
  });

  router.put("/tables/:id/tariffs", (req, res) => {
    requirePermission(db, req, "manage_tables");
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    // Принимаем и один тариф («цена стола»), и список — так удобнее и
    // интерфейсу, и старым клиентам API.
    const raw = req.body?.tariff_ids ?? req.body?.tariff_id;
    const ids = (Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw])
      .map(Number)
      .filter((id) => Number.isInteger(id));
    res.json({ tariff_ids: setAllowedTariffIds(db, tableId, ids, req.user) });
  });

  router.post("/tables/:id/open", (req, res) => {
    const tableId = intParam(req.params.id);
    // Тариф необязателен: кассир открывает время, а цену берём с самого
    // стола (её назначает администратор). Переданный тариф по-прежнему
    // принимается — им пользуются администратор и старые клиенты API.
    const tariffId = intParam(req.body?.tariff_id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    const clientId = intParam(req.body?.client_id);
    // Режимы: postpaid (по умолчанию), time (минуты вперёд), amount (сумма),
    // free (бесплатное время — отдельное право).
    const mode = req.body?.mode ?? "postpaid";
    // Деньги со счёта клиента списываются сами; кассир может отказаться
    // (гость хочет заплатить наличными и сохранить счёт).
    const options = { clientId, useBalance: req.body?.use_balance !== false };
    if (mode === "time") {
      options.prepaidSeconds = Math.round(Number(req.body?.minutes) * 60);
      options.paymentMethod = req.body?.payment_method ?? null;
    } else if (mode === "amount") {
      options.prepaidAmount = Number(req.body?.amount);
      options.paymentMethod = req.body?.payment_method ?? null;
    } else if (mode === "voucher") {
      // Игра по чеку на остаток: денег не берём, время даёт сам чек.
      options.voucherCode = String(req.body?.voucher_code ?? "").trim();
      if (!options.voucherCode) {
        throw new ConflictError("Укажите код чека");
      }
    } else if (mode === "free") {
      requirePermission(db, req, "open_free_time");
      options.isFree = true;
    } else if (mode !== "postpaid") {
      throw new ConflictError(`Неизвестный режим открытия «${mode}»`);
    }
    res
      .status(201)
      .json(sessionToOut(openSession(db, tableId, tariffId, req.user, options)));
  });

  // Продление открытого чека: «ещё 30 минут» или «ещё на 5000».
  router.post("/tables/:id/extend", (req, res) => {
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    const body = req.body ?? {};
    res.json(
      sessionToOut(
        extendSession(db, tableId, req.user, {
          minutes: body.minutes === undefined || body.minutes === null
            ? null
            : Number(body.minutes),
          amount: body.amount === undefined || body.amount === null
            ? null
            : Number(body.amount),
          paymentMethod: body.payment_method ?? null,
          useBalance: body.use_balance !== false,
        })
      )
    );
  });

  // Пересадка гостей на другой стол вместе с оплатой и таймером.
  router.post("/tables/:id/move", (req, res) => {
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    res.json(
      sessionToOut(
        moveSession(db, tableId, req.user, {
          targetTableId: req.body?.target_table_id ?? null,
        })
      )
    );
  });

  router.post("/tables/:id/close", (req, res) => {
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    const paymentMethod = req.body?.payment_method ?? null;
    const closed = closeSession(db, tableId, req.user, {
      paymentMethod,
      useBalance: req.body?.use_balance !== false,
    });
    // Выданный чек на остаток отдаём вместе с сеансом: его код кассир
    // сообщает гостю и печатает на чеке.
    res.json({
      ...sessionToOut(closed),
      issued_voucher: closed.issued_voucher ? voucherToOut(closed.issued_voucher) : null,
      // true — остаток лёг на прежний чек, код гостю называть не нужно.
      reused_voucher: Boolean(closed.reused_voucher),
      // Сколько ушло со счёта клиента и сколько вернулось на счёт.
      paid_from_account: closed.paid_from_account ?? 0,
      refunded_to_account: closed.refunded_to_account ?? 0,
      // Подарочный чек за наигранные часы (акция «каждый N-й час»).
      bonus_voucher: closed.bonus_voucher
        ? { ...voucherToOut(closed.bonus_voucher), bonus_hours: closed.bonus_voucher.bonus_hours }
        : null,
    });
  });

  // Предпросмотр чека открытого сеанса (время, скидка, бар, итог).
  router.get("/tables/:id/check", (req, res) => {
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    const session = getOpenSession(db, tableId);
    if (!session) {
      throw new ConflictError("Стол свободен — чека нет");
    }
    const check = computeCheck(db, session, utcNow());
    res.json({
      session_id: session.id,
      table_name: session.table_name,
      tariff_name: session.tariff_name,
      client_name: session.client_name ?? null,
      duration_seconds: check.duration_seconds,
      billed_seconds: check.billed_seconds,
      time_cost: kopecksToRubles(check.time_cost_kopecks),
      discount_percent: check.discount_percent,
      discounted_time: kopecksToRubles(check.discounted_time_kopecks),
      bar_cost: kopecksToRubles(check.bar_cost_kopecks),
      total: kopecksToRubles(check.total_kopecks),
      prepaid: check.prepaid,
      free: check.free,
      // Предоплата: сколько уже в кассе, сколько добрать и сколько вернуть.
      prepaid_amount: kopecksToRubles(check.prepaid_kopecks),
      prepaid_seconds: check.prepaid_seconds,
      due: kopecksToRubles(check.due_kopecks),
      change: kopecksToRubles(check.change_kopecks),
      // Счёт клиента: что уже списано, что осталось и как разложится доплата.
      paid_from_account: kopecksToRubles(check.paid_from_account_kopecks),
      account_left: kopecksToRubles(check.account_left_kopecks),
      due_from_account: kopecksToRubles(check.due_from_account_kopecks),
      due_money: kopecksToRubles(check.due_money_kopecks),
      change_to_account: kopecksToRubles(check.change_to_account_kopecks),
      prepaid_mode: check.prepaid_mode,
      // Остаток, который при закрытии станет чеком (для «чека на сумму»).
      voucher_out: kopecksToRubles(check.voucher_out_kopecks),
      paid_by_voucher: kopecksToRubles(check.voucher_kopecks),
      voucher_code: check.voucher_code,
      unused_seconds: check.unused_seconds,
      overtime_seconds: check.overtime_seconds,
      orders: listOrders(db, session.id).map((o) => ({
        id: o.id,
        item_name: o.item_name,
        price: kopecksToRubles(o.price_kopecks),
        quantity: o.quantity,
      })),
    });
  });

  // --- Бар: заказы на открытый сеанс ---------------------------------------

  router.post("/tables/:id/orders", (req, res) => {
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    const result = addOrder(db, tableId, req.body ?? {}, req.user);
    res.status(201).json({
      orders: result.orders,
      bar_total: kopecksToRubles(result.bar_total_kopecks),
    });
  });

  router.delete("/orders/:id", (req, res) => {
    const orderId = intParam(req.params.id);
    if (orderId === null) return res.status(404).json({ detail: "Позиция не найдена" });
    const result = removeOrder(db, orderId);
    res.json({
      orders: result.orders,
      bar_total: kopecksToRubles(result.bar_total_kopecks),
    });
  });

  // --- Чек закрытого сеанса ------------------------------------------------

  router.get("/sessions/:id", (req, res) => {
    const sessionId = intParam(req.params.id);
    if (sessionId === null) return res.status(404).json({ detail: "Сеанс не найден" });
    const session = getSessionById(db, sessionId);
    // Чеки, выданные по итогам этого сеанса: остаток и подарок за
    // наигранные часы печатаются на чеке разными строками.
    const all = listVouchers(db, { status: "all", limit: 1000 });
    const own = all.filter((v) => v.source_session_id === session.id);
    // Если играли по чеку и не доиграли, остаток лёг на ТОТ ЖЕ чек — он
    // числится за первым сеансом, поэтому ищем его отдельно по сеансу.
    const reused =
      session.voucher_id
        ? all.find(
            (v) => v.id === session.voucher_id && v.status === "active" && v.balance > 0
          ) ?? null
        : null;
    res.json({
      ...sessionToOut(session),
      club_name: getClubSettings(db).club_name,
      issued_voucher: own.find((v) => v.kind !== "bonus") ?? reused,
      bonus_voucher: own.find((v) => v.kind === "bonus") ?? null,
      orders: listOrders(db, session.id).map((o) => ({
        item_name: o.item_name,
        price: kopecksToRubles(o.price_kopecks),
        quantity: o.quantity,
      })),
    });
  });

  // --- Тарифы ------------------------------------------------------------

  router.get("/tariffs", (req, res) => {
    res.json(listTariffs(db, { onlyActive: req.query.only_active === "true" }));
  });

  router.post("/tariffs", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    if (typeof req.body?.name !== "string") {
      throw new ConflictError("Поле name обязательно и должно быть строкой");
    }
    res
      .status(201)
      .json(createTariff(db, req.body.name, Number(req.body.price_per_hour)));
  });

  router.put("/tariffs/:id", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    const tariffId = intParam(req.params.id);
    if (tariffId === null) return res.status(404).json({ detail: "Тариф не найден" });
    res.json(updateTariff(db, tariffId, req.body ?? {}));
  });

  router.delete("/tariffs/:id", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    const tariffId = intParam(req.params.id);
    if (tariffId === null) return res.status(404).json({ detail: "Тариф не найден" });
    res.json(deleteTariff(db, tariffId));
  });

  // --- Dashboard: столы с живым состоянием сеансов -----------------------
  // Сервер сам считает elapsed_seconds и current_cost — фронтенду не нужно
  // сверять часы с сервером, он лишь тикает между опросами.

  // Экран для гостей (телевизор в зале). Открыт без входа, поэтому
  // отдаём только то, что и так видно любому вошедшему в клуб: какие
  // столы свободны и почём час. Ни выручки, ни имён клиентов, ни
  // таймеров чужих сеансов здесь нет.
  router.get("/board", (req, res) => {
    const club = getClubSettings(db);
    const tz = club.tz_offset_minutes;
    const promo = activePromotion(db, tz);
    const autoTariffId = resolveTariffId(db, tz);
    const tariffs = listTariffs(db, { onlyActive: true });
    res.json({
      club_name: club.club_name,
      club_logo: club.club_logo,
      currency: club.currency,
      // Тариф, который сейчас действует по расписанию (если задано).
      current_tariff_id: autoTariffId,
      tariffs: tariffs.map((t) => ({
        id: t.id,
        name: t.name,
        price_per_hour: t.price_per_hour,
      })),
      promotion: promo
        ? { name: promo.name, discount_percent: promo.discount_percent }
        : null,
      tables: listTables(db).map((table) => ({
        id: table.id,
        name: table.name,
        kind: table.kind,
        free: !getOpenSession(db, table.id),
      })),
    });
  });

  router.get("/dashboard", (req, res) => {
    const lighting = getLightingController(db);
    const now = Date.now();
    // Тариф по расписанию считаем один раз на весь дашборд, а не на стол.
    const autoTariffId = resolveTariffId(db, getClubSettings(db).tz_offset_minutes);
    const result = listTables(db).map((table) => {
      const session = getOpenSession(db, table.id);
      const booking = nextBookingForTable(db, table.id);
      // Цена этого стола: её назначает администратор, кассир только
      // открывает время — поэтому отдаём готовый тариф, а не список.
      const tariffId = resolveTableTariffId(db, table.id, autoTariffId);
      const tariff = tariffId ? getTariff(db, tariffId) : null;
      return {
        id: table.id,
        name: table.name,
        status: table.status,
        kind: table.kind,
        allowed_tariff_ids: getAllowedTariffIds(db, table.id),
        tariff: tariff
          ? {
              id: tariff.id,
              name: tariff.name,
              price_per_hour: tariff.price_per_hour,
              // true — тариф закреплён за столом администратором.
              assigned: getAllowedTariffIds(db, table.id).length > 0,
            }
          : null,
        light_on: lighting.isLightOn(table.id),
        pos_x: table.pos_x,
        pos_y: table.pos_y,
        size_w: table.size_w,
        size_h: table.size_h,
        booking: booking
          ? {
              id: booking.id,
              client_name: booking.client_name,
              starts_at: booking.starts_at,
              duration_minutes: booking.duration_minutes,
              // Конец брони считает сервер: кассиру важно видеть, до какого
              // часа стол занят, а не пересчитывать это в браузере.
              ends_at: endsAtIso(booking),
            }
          : null,
        session: session
          ? (() => {
              const elapsed = Math.max(
                0,
                Math.floor((now - Date.parse(session.started_at)) / 1000)
              );
              const prepaid =
                session.prepaid_kopecks !== null &&
                session.prepaid_kopecks !== undefined;
              return {
                session_id: session.id,
                tariff_name: session.tariff_name,
                price_per_hour: session.price_per_hour_snapshot,
                started_at: session.started_at,
                client_name: session.client_name ?? null,
                discount_percent: session.discount_percent ?? 0,
                is_free: Boolean(session.is_free),
                elapsed_seconds: elapsed,
                current_cost: kopecksToRubles(currentCostKopecks(db, session)),
                prepaid,
                prepaid_seconds: prepaid ? session.prepaid_seconds : null,
                prepaid_amount: prepaid
                  ? kopecksToRubles(session.prepaid_kopecks)
                  : null,
                prepaid_mode: session.prepaid_mode ?? null,
                voucher_code: session.voucher_code ?? null,
                payment_method: session.payment_method ?? null,
                // Счёт клиента: из него сначала списывается продление и
                // доплата при закрытии.
                client_account: kopecksToRubles(session.client_account_kopecks ?? 0),
                paid_from_account: kopecksToRubles(session.account_kopecks ?? 0),
                remaining_seconds: prepaid
                  ? session.prepaid_seconds - elapsed
                  : null,
                expired: prepaid ? elapsed >= session.prepaid_seconds : false,
              };
            })()
          : null,
      };
    });
    res.json(result);
  });

  // --- Настройки -----------------------------------------------------------
  // Всё, что нужно для реле Tuya/MOES, задаётся отсюда (вкладка «Настройки»):
  // драйвер и ключи облака, привязка столов к устройствам, тест реле.

  // Ключи облака Tuya — учётные данные, а не рядовая настройка клуба:
  // видит и меняет их только разработчик, остальным сотрудникам они
  // не нужны и не должны утекать даже в ответ API.
  const TUYA_KEYS = new Set(["lighting_driver", "tuya_api_host", "tuya_access_id", "tuya_access_secret"]);
  const hasTuyaKeys = (body) => Object.keys(body ?? {}).some((k) => TUYA_KEYS.has(k));
  const maskTuyaSettings = (settings, req) => {
    if (req.user?.role === "developer") return settings;
    return { ...settings, tuya_access_id: "", tuya_access_secret: "" };
  };

  router.get("/settings", (req, res) => {
    requirePermission(db, req, "manage_settings");
    res.json({
      ...maskTuyaSettings(getSettings(db), req),
      driver_active: getActiveDriver(db),
    });
  });

  router.put("/settings", async (req, res, next) => {
    try {
      requirePermission(db, req, "manage_settings");
      if (hasTuyaKeys(req.body)) requireDeveloper(req);
      saveSettings(db, req.body ?? {});
      const status = await initLighting(db);
      logEvent(
        db,
        JournalEvent.SETTINGS_UPDATED,
        `Обновлены настройки${hasTuyaKeys(req.body) ? " освещения" : ""} — ${req.user.name}`
      );
      res.json({
        ...maskTuyaSettings(getSettings(db), req),
        driver_active: status.driver,
        driver_error: status.error ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  // Состояние программы и базы + последние внутренние ошибки: чтобы
  // причину «внутренней ошибки сервера» было видно из интерфейса.
  router.get("/diagnostics", (req, res) => {
    requireDeveloper(req);
    requireOwnServer();
    // Автоматические копии показываем здесь же: видно, что страховка
    // работает и когда сделана последняя копия.
    res.json({
      ...diagnostics(db),
      backups: {
        folder: backupDir(),
        keep: keepBackups(),
        files: listBackups().slice(0, 14),
      },
    });
  });

  // Сделать копию прямо сейчас, не дожидаясь суточной.
  router.post("/backup/now", (req, res) => {
    ownerLevel(db, req);
    const made = makeBackupNow(db);
    logEvent(
      db,
      JournalEvent.SETTINGS_UPDATED,
      `Сделана резервная копия базы «${made.name}» — ${req.user.name}`
    );
    res.status(201).json(made);
  });

  // --- Инструменты поддержки -----------------------------------------------

  // Пакет диагностики: один текстовый файл, который клиент присылает
  // разработчику вместо «у нас что-то не работает».
  router.get("/support/report", (req, res) => {
    requireDeveloper(req);
    requireOwnServer();
    const report = buildSupportReport(db, req.user, {
      requests: recentRequests(db, { limit: 200 }),
      issues: checkupData(db).issues,
    });
    logEvent(
      db,
      JournalEvent.SETTINGS_UPDATED,
      `Собран пакет диагностики — ${req.user.name}`
    );
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${supportReportFileName()}"`
    );
    res.send(report);
  });

  // Настройка клуба одним файлом: перенос на другой компьютер без истории.
  router.get("/config/export", (req, res) => {
    ownerLevel(db, req);
    const config = exportConfig(db);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${configFileName(config.club_name)}"`
    );
    res.send(JSON.stringify(config, null, 2));
  });

  router.post("/config/import", (req, res) => {
    ownerLevel(db, req);
    res.json(importConfig(db, req.body, req.user));
  });

  // Запрос к базе только на чтение. Только разработчик: см. sql-console.js.
  router.post("/support/query", (req, res) => {
    requireDeveloper(req);
    res.json(runReadOnlyQuery(db, req.user, req.body?.sql ?? ""));
  });

  // Таблицы и колонки — подсказка к запросам.
  router.get("/support/schema", (req, res) => {
    requireDeveloper(req);
    res.json({ tables: describeSchema() });
  });

  // Демо-данные: показать программу клиенту на непустой базе.
  // Только разработчик: на рабочей базе клуба это не нужно никому.
  router.get("/demo", (req, res) => {
    requireDeveloper(req);
    res.json(demoDataPresent(db));
  });

  router.post("/demo", (req, res) => {
    requireDeveloper(req);
    const days = clampLimit(req.body?.days, 30, 180);
    res.status(201).json(fillDemoData(db, req.user, { days }));
  });

  router.delete("/demo", (req, res) => {
    requireDeveloper(req);
    res.json(clearDemoData(db, req.user));
  });

  // Перезапуск программы из интерфейса. Работает, когда сервер запущен
  // через start-club.bat (run-server.bat поднимает его снова по коду 7);
  // иначе программа просто остановится, и её нужно будет запустить руками.
  router.post("/system/restart", (req, res) => {
    requireDeveloper(req);
    requireOwnServer();
    logEvent(
      db,
      JournalEvent.SETTINGS_UPDATED,
      `Перезапуск программы из интерфейса — ${req.user.name}`
    );
    res.json({ ok: true, note: "Программа перезапускается — обновите страницу через 5–10 секунд" });
    // Даём ответу уйти к браузеру и только потом выходим.
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
  });

  // Доктор данных: что не так и можно ли починить кнопкой.
  router.get("/support/checkup", (req, res) => {
    requireDeveloper(req);
    res.json(checkupData(db));
  });

  router.post("/support/fix", (req, res) => {
    requireDeveloper(req);
    res.json(fixData(db, req.user, req.body?.code ?? null));
  });

  // Журнал запросов: метод, адрес, код ответа, время, сотрудник.
  router.get("/support/requests", (req, res) => {
    requireDeveloper(req);
    res.json({
      requests: recentRequests(db, {
        limit: clampLimit(req.query.limit, 200, 200),
        onlyErrors: req.query.only_errors === "true",
      }),
    });
  });

  router.delete("/support/requests", (req, res) => {
    requireDeveloper(req);
    clearRequests(db);
    res.json({ ok: true });
  });

  // --- Свет над столом -----------------------------------------------------

  // Ручное включение и выключение: нужно при настройке реле («а тот ли
  // это стол?») и когда свет забыли выключить.
  router.post("/tables/:id/light", async (req, res, next) => {
    try {
      requirePermission(db, req, "manage_tables");
      const tableId = intParam(req.params.id);
      if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
      const table = listTables(db).find((t) => t.id === tableId);
      if (!table) return res.status(404).json({ detail: "Стол не найден" });
      const on = Boolean(req.body?.on);
      try {
        await getLightingController(db).setLight(table.id, on);
      } catch (error) {
        throw new ConflictError(error.message);
      }
      logEvent(
        db,
        on ? JournalEvent.LIGHT_ON : JournalEvent.LIGHT_OFF,
        `${on ? "Включён" : "Выключен"} свет над столом «${table.name}» вручную — ${req.user.name}`,
        { tableId: table.id }
      );
      res.json({ table_id: table.id, light_on: on });
    } catch (error) {
      next(error);
    }
  });

  // Привести свет в зале в соответствие с занятыми столами.
  // Настройка реле — работа разработчика: остальным сотрудникам она
  // не нужна, а учётные данные и адреса устройств светить незачем.
  router.post("/lighting/sync", async (req, res, next) => {
    try {
      requireDeveloper(req);
      res.json(await syncLighting(db));
    } catch (error) {
      next(error);
    }
  });

  // --- Устройства зала: кондиционер, вытяжка, приток ----------------------
  // Не столы: без сеансов и тарифов, только реле и цикл «работает N минут —
  // стоит M». Щёлкать и включать цикл может любой сотрудник (это как
  // выключатель на стене), заводить и настраивать — кто ведёт настройки.

  router.get("/devices", (req, res) => {
    res.json(listDevices(db));
  });

  router.post("/devices", (req, res) => {
    requirePermission(db, req, "manage_settings");
    const device = createDevice(db, req.body ?? {});
    logEvent(
      db,
      JournalEvent.SETTINGS_UPDATED,
      `Добавлено устройство «${device.name}» — ${req.user.name}`
    );
    res.status(201).json(device);
  });

  router.put("/devices/:id", (req, res) => {
    requirePermission(db, req, "manage_settings");
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Устройство не найдено" });
    res.json(updateDevice(db, id, req.body ?? {}));
  });

  router.delete("/devices/:id", async (req, res, next) => {
    try {
      requirePermission(db, req, "manage_settings");
      const id = intParam(req.params.id);
      if (id === null) return res.status(404).json({ detail: "Устройство не найдено" });
      const device = await deleteDevice(db, id);
      logEvent(
        db,
        JournalEvent.SETTINGS_UPDATED,
        `Удалено устройство «${device.name}» — ${req.user.name}`
      );
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/devices/:id/power", async (req, res, next) => {
    try {
      const id = intParam(req.params.id);
      if (id === null) return res.status(404).json({ detail: "Устройство не найдено" });
      const on = Boolean(req.body?.on);
      const device = await setDevicePower(db, id, on);
      logEvent(
        db,
        on ? JournalEvent.DEVICE_ON : JournalEvent.DEVICE_OFF,
        `${on ? "Включено" : "Выключено"} устройство «${device.name}» вручную — ${req.user.name}`
      );
      res.json(device);
    } catch (error) {
      next(error);
    }
  });

  // Решётка канала: положение в процентах (0 — закрыть).
  router.post("/devices/:id/position", async (req, res, next) => {
    try {
      const id = intParam(req.params.id);
      if (id === null) return res.status(404).json({ detail: "Устройство не найдено" });
      const device = await setDevicePosition(db, id, req.body?.percent);
      logEvent(
        db,
        JournalEvent.DEVICE_POSITION,
        `«${device.name}»: ${device.position ? `положение ${device.position}%` : "закрыта"} — ${req.user.name}`
      );
      res.json(device);
    } catch (error) {
      next(error);
    }
  });

  router.post("/devices/:id/cycle", async (req, res, next) => {
    try {
      const id = intParam(req.params.id);
      if (id === null) return res.status(404).json({ detail: "Устройство не найдено" });
      const on = Boolean(req.body?.on);
      const device = await setDeviceCycle(db, id, on);
      logEvent(
        db,
        JournalEvent.DEVICE_CYCLE,
        `«${device.name}»: цикл ${device.work_minutes}/${device.rest_minutes} мин ` +
          `${on ? "включён" : "выключен"} — ${req.user.name}`
      );
      res.json(device);
    } catch (error) {
      next(error);
    }
  });

  // Реле над столами: кто привязан, горит ли, отвечает ли по сети.
  // Смотрят все — это состояние зала, а не настройка.
  router.get("/relays", (req, res) => {
    const lighting = getLightingController(db);
    res.json(
      listTables(db)
        .filter((t) => t.light_kind || t.tuya_device_id)
        .map((t) => ({
          table_id: t.id,
          name: t.name,
          kind: t.light_kind ?? "tuya",
          light_on: lighting.isLightOn(t.id),
          online: relayOnline(db, "table", t.id),
        }))
    );
  });

  // Опросить все реле прямо сейчас, не дожидаясь тика.
  router.post("/relays/probe", async (req, res, next) => {
    try {
      res.json(await probeRelays(db));
    } catch (error) {
      next(error);
    }
  });

  // --- Напоминания о бронях в Telegram ------------------------------------

  // Проверка связи: отправляет тестовое сообщение в чат клуба.
  router.post("/telegram/test", async (req, res, next) => {
    try {
      requirePermission(db, req, "manage_settings");
      res.json(await sendTelegramTest(db, req.user));
    } catch (error) {
      next(error);
    }
  });

  // --- Подписка: связь с центральной панелью сети WesPro ------------------

  // Кнопка «Проверить подписку»: живой запрос к хабу, а не что-то
  // закэшированное — открытие вкладки «Настройки» само по себе хаб не
  // дёргает (незачем ждать сеть каждый раз, когда кассир туда заходит).
  router.post("/subscription/check", async (req, res, next) => {
    try {
      requirePermission(db, req, "manage_settings");
      res.json(await checkSubscriptionNow(db));
    } catch (error) {
      next(error);
    }
  });

  // Разослать напоминания прямо сейчас, не дожидаясь минутной проверки.
  router.post("/telegram/remind", async (req, res, next) => {
    try {
      requirePermission(db, req, "manage_settings");
      res.json(await remindUpcomingBookings(db));
    } catch (error) {
      next(error);
    }
  });

  // Настроен ли бот — чтобы в интерфейсе честно писать «выключено».
  router.get("/telegram/status", (req, res) => {
    requirePermission(db, req, "manage_settings");
    const config = telegramConfig(db);
    res.json({
      configured: Boolean(config),
      before_minutes: config?.beforeMinutes ?? null,
    });
  });

  // Адреса, по которым клуб открывается с телефона/планшета/ноутбука.
  // Показывается во вкладке «Настройки», чтобы не искать их в консоли.
  router.get("/network", (req, res) => {
    requireDeveloper(req);
    requireOwnServer();
    res.json(networkInfo(PORT));
  });

  router.get("/settings/devices", async (req, res, next) => {
    try {
      requireDeveloper(req);
      res.json(await listCloudDevices(db));
    } catch (error) {
      next(error);
    }
  });

  router.put("/tables/:id/device", (req, res) => {
    requireDeveloper(req);
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    const body = req.body ?? {};
    // Тип не прислали, но прислали устройство Tuya — значит настраивают
    // по-старому (в прежних версиях другого типа и не было).
    const kind = body.kind ?? (body.device_id ? "tuya" : null);
    const table = setTableDevice(db, tableId, { ...body, kind });
    res.json(table);
  });

  // Ручной тест реле из настроек: включить/выключить свет над столом.
  // --- План зала -----------------------------------------------------------
  // Смотрят все сотрудники, редактирует администратор.

  router.get("/plan", (req, res) => {
    res.json(getPlan(db));
  });

  router.put("/plan", (req, res) => {
    requirePermission(db, req, "manage_tables");
    res.json(savePlan(db, req.body ?? {}));
  });

  router.put("/tables/:id/layout", (req, res) => {
    requirePermission(db, req, "manage_tables");
    const tableId = intParam(req.params.id);
    if (tableId === null) return res.status(404).json({ detail: "Стол не найден" });
    const { x, y, w, h } = req.body ?? {};
    res.json(
      setTableLayout(db, tableId, {
        x: Number(x),
        y: Number(y),
        w: Number(w),
        h: Number(h),
      })
    );
  });

  // --- Клиенты -------------------------------------------------------------
  // Создавать клиентов может любой сотрудник; менять скидку — администратор.

  router.get("/clients", (req, res) => {
    res.json(
      listClients(db, { query: String(req.query.query ?? "") }).map((client) => ({
        ...client,
        // Счёт клиента в рублях — кассир видит его при открытии стола.
        account: kopecksToRubles(client.account_kopecks ?? 0),
      }))
    );
  });

  router.post("/clients", (req, res) => {
    res.status(201).json(createClient(db, req.body ?? {}, req.user));
  });

  // Пополнение счёта клиента: касса берёт деньги заранее и выдаёт чек,
  // которым можно расплатиться позже за любой стол (вкладка «Касса»).
  router.post("/clients/:id/topup", (req, res) => {
    const clientId = intParam(req.params.id);
    if (clientId === null) return res.status(404).json({ detail: "Клиент не найден" });
    const voucher = topUpClient(db, clientId, req.user, {
      amount: req.body?.amount,
      paymentMethod: req.body?.payment_method ?? "cash",
    });
    res.status(201).json(voucherToOut(voucher));
  });

  // --- Чеки на остаток ---------------------------------------------------

  router.get("/vouchers", (req, res) => {
    res.json(
      listVouchers(db, {
        status: req.query.status ? String(req.query.status) : "active",
        clientId: req.query.client_id ? intParam(req.query.client_id) : null,
        kind: req.query.kind ? String(req.query.kind) : null,
        limit: clampLimit(req.query.limit, 200, 1000),
      })
    );
  });

  // Поиск чека по коду — кассир вводит код с бумажки.
  router.get("/vouchers/by-code/:code", (req, res) => {
    const voucher = findVoucherByCode(db, req.params.code);
    if (!voucher) {
      return res.status(404).json({ detail: "Чек не найден — проверьте код" });
    }
    res.json(voucherToOut(voucher));
  });

  // Отмена ошибочно выданного чека (использованный отменить нельзя).
  router.delete("/vouchers/:id", (req, res) => {
    requirePermission(db, req, "manage_settings");
    const voucherId = intParam(req.params.id);
    if (voucherId === null) {
      return res.status(404).json({ detail: "Чек не найден" });
    }
    res.json(cancelVoucher(db, voucherId, req.user));
  });

  // Статистика клиента: средний расход, время и посещения по периодам.
  router.get("/clients/:id/stats", (req, res) => {
    const clientId = intParam(req.params.id);
    if (clientId === null) {
      return res.status(404).json({ detail: "Клиент не найден" });
    }
    const stats = clientStats(db, clientId);
    const money = (kopecks) => kopecksToRubles(kopecks);
    const period = (p) => ({
      visits: p.visits,
      spent: money(p.spent_kopecks),
      seconds: p.seconds,
      average: money(p.average_kopecks),
      average_seconds: p.average_seconds,
    });
    const favorite = (rows) =>
      rows.map((r) => ({
        name: r.name,
        visits: r.visits,
        seconds: r.seconds,
        spent: money(r.spent_kopecks),
      }));
    res.json({
      client_id: stats.client_id,
      name: stats.name,
      discount_percent: stats.discount_percent,
      last_visit: stats.last_visit,
      total: period(stats.total),
      day: period(stats.day),
      week: period(stats.week),
      month: period(stats.month),
      favorite_tables: favorite(stats.favorite_tables),
      favorite_tariffs: favorite(stats.favorite_tariffs),
    });
  });

  router.put("/clients/:id", (req, res) => {
    requirePermission(db, req, "manage_clients");
    const clientId = intParam(req.params.id);
    if (clientId === null) return res.status(404).json({ detail: "Клиент не найден" });
    res.json(updateClient(db, clientId, req.body ?? {}));
  });

  // --- Меню бара -----------------------------------------------------------

  router.get("/menu", (req, res) => {
    res.json(listMenu(db, { onlyActive: req.query.only_active === "true" }));
  });

  router.post("/menu", (req, res) => {
    requirePermission(db, req, "manage_bar");
    res.status(201).json(createMenuItem(db, req.body ?? {}));
  });

  router.put("/menu/:id", (req, res) => {
    requirePermission(db, req, "manage_bar");
    const itemId = intParam(req.params.id);
    if (itemId === null) return res.status(404).json({ detail: "Позиция не найдена" });
    res.json(updateMenuItem(db, itemId, req.body ?? {}));
  });

  router.delete("/menu/:id", (req, res) => {
    requirePermission(db, req, "manage_bar");
    const itemId = intParam(req.params.id);
    if (itemId === null) return res.status(404).json({ detail: "Позиция не найдена" });
    res.json(deleteMenuItem(db, itemId));
  });

  // --- Брони ---------------------------------------------------------------

  router.get("/bookings", (req, res) => {
    res.json(listBookings(db));
  });

  router.post("/bookings", (req, res) => {
    res.status(201).json(createBooking(db, req.body ?? {}, req.user));
  });

  router.post("/bookings/:id/cancel", (req, res) => {
    const bookingId = intParam(req.params.id);
    if (bookingId === null) return res.status(404).json({ detail: "Бронь не найдена" });
    res.json(cancelBooking(db, bookingId, req.user));
  });

  // --- Тарифные расписания (только администратор) --------------------------

  router.get("/tariff-rules", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    res.json(listRules(db));
  });

  router.post("/tariff-rules", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    res.status(201).json(createRule(db, req.body ?? {}));
  });

  router.delete("/tariff-rules/:id", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    const ruleId = intParam(req.params.id);
    if (ruleId === null) return res.status(404).json({ detail: "Правило не найдено" });
    deleteRule(db, ruleId);
    res.json({ ok: true });
  });

  // --- Акции «счастливый час» ---------------------------------------------

  router.get("/promotions", (req, res) => {
    res.json(listPromotions(db));
  });

  router.post("/promotions", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    res.status(201).json(createPromotion(db, req.body ?? {}));
  });

  router.put("/promotions/:id", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Акция не найдена" });
    res.json(setPromotionActive(db, id, Boolean(req.body?.is_active)));
  });

  router.delete("/promotions/:id", (req, res) => {
    requirePermission(db, req, "manage_tariffs");
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Акция не найдена" });
    deletePromotion(db, id);
    res.json({ ok: true });
  });

  // Действующая сейчас акция — подсказка при открытии стола.
  router.get("/promotions/active", (req, res) => {
    const tz = getClubSettings(db).tz_offset_minutes;
    res.json({ promotion: activePromotion(db, tz) });
  });

  // Тариф по расписанию на «сейчас» — для автоподстановки при открытии.
  router.get("/tariffs/auto", (req, res) => {
    const tz = getClubSettings(db).tz_offset_minutes;
    res.json({ tariff_id: resolveTariffId(db, tz) });
  });

  // Учёт часов и начислений сотрудникам: часы берутся из кассовых смен.
  router.get("/payroll", (req, res) => {
    requirePermission(db, req, "view_reports");
    const days = clampLimit(req.query.days, 30, 365);
    res.json(payrollReport(db, { days }));
  });

  // --- Отчёт по выручке (только администратор) -----------------------------

  router.get("/stats/revenue", (req, res) => {
    requirePermission(db, req, "view_reports");
    const days = clampLimit(req.query.days, 30, 365);
    res.json({ days, ...revenueReport(db, days) });
  });

  // Сводный дашборд клуба (выручка, средние, дни недели, топ бара).
  router.get("/stats/overview", (req, res) => {
    requirePermission(db, req, "view_reports");
    res.json(overview(db));
  });

  // Экспорт истории сеансов в CSV (для Excel).
  router.get("/export/history.csv", (req, res) => {
    requirePermission(db, req, "view_reports");
    const rows = listHistory(db, 10000).map(sessionToOut);
    const cur = getClubSettings(db).currency;
    const header =
      `Стол;Тариф;Клиент;Начало;Конец;Длительность (мин);Время, ${cur};Бар, ${cur};Итог, ${cur};Оплата;Кассир`;
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((s) =>
      [
        s.table_name,
        s.tariff_name,
        s.client_name ?? "",
        s.started_at,
        s.ended_at,
        Math.round(s.duration_seconds / 60),
        s.time_cost ?? s.total_cost,
        s.bar_cost ?? 0,
        s.total_cost,
        s.payment_method ?? "",
        s.closed_by_name ?? "",
      ]
        .map(esc)
        .join(";")
    );
    // BOM — чтобы Excel открыл кириллицу корректно.
    const csv = "﻿" + [header, ...lines].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="history.csv"');
    res.send(csv);
  });

  // Резервная копия базы данных: выгрузка файла SQLite.
  router.get("/backup", (req, res, next) => {
    try {
      requirePermission(db, req, "manage_settings");
      const target = exportBackupFile(db);
      res.download(target, backupFileName(), () => {
        fs.unlink(target, () => {});
      });
    } catch (error) {
      next(error);
    }
  });

  // Загрузка своей копии обратно: тело запроса — сам файл .db
  // (Content-Type: application/octet-stream, см. express.raw в app.js).
  // Операция затирает все текущие данные, поэтому доступна только
  // владельцу/разработчику — в обход матрицы прав.
  router.post("/backup/import", async (req, res, next) => {
    let temp = null;
    try {
      ownerLevel(db, req);
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      if (!body?.length) {
        throw new ConflictError("Файл копии не получен — выберите файл .db");
      }
      temp = path.join(os.tmpdir(), `billiards-import-${Date.now()}.db`);
      fs.writeFileSync(temp, body);

      const result = importBackupFile(db, temp);
      // Настройки освещения пришли из копии — переподнимаем драйвер.
      const status = await initLighting(db);
      logEvent(
        db,
        JournalEvent.BACKUP_RESTORED,
        `База восстановлена из копии (${result.tables.length} таблиц) — ${req.user.name}`
      );
      // Все токены входа обнулены вместе с базой: текущую cookie тоже гасим,
      // чтобы браузер сразу ушёл на страницу входа.
      res.setHeader("Set-Cookie", clearedSessionCookie());
      res.json({
        ok: true,
        tables: result.tables,
        skipped: result.skipped,
        driver_active: status.driver,
        driver_error: status.error ?? null,
      });
    } catch (error) {
      next(error);
    } finally {
      if (temp) fs.unlink(temp, () => {});
    }
  });

  // --- История и журнал ---------------------------------------------------

  router.get("/history", (req, res) => {
    const limit = clampLimit(req.query.limit, 100, 1000);
    res.json(listHistory(db, limit).map(sessionToOut));
  });

  router.get("/journal", (req, res) => {
    requirePermission(db, req, "view_journal");
    const limit = clampLimit(req.query.limit, 200, 1000);
    res.json(listJournal(db, limit));
  });

  // --- Права ролей (только владелец/разработчик) ----------------------------

  router.get("/permissions", (req, res) => {
    ownerLevel(db, req);
    res.json(getPermissionMatrix(db));
  });

  router.put("/permissions", (req, res) => {
    ownerLevel(db, req);
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    res.json(setPermissions(db, entries));
  });

  return router;
}
