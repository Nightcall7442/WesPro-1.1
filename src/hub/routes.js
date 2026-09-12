// Маршруты центральной панели. Две независимые части:
//
// • /hub/api/…       — панель владельца сервиса (вход по cookie);
// • /hub/api/agent/… — программы самих клубов (вход по ключу клуба).
//
// Разделение принципиальное: клуб своим ключом может только отметиться
// на связи и забрать сообщения. Ни списка соседей, ни чужих оплат он не
// видит — ключ утёк бы вместе с компьютером клуба.

import express from "express";

import { ConflictError, ForbiddenError, NotFoundError } from "../services/errors.js";
import { hubSettings, saveHubSettings } from "./db.js";
import {
  addPayment,
  archiveClub,
  clubByApiKey,
  createClub,
  getClub,
  grantGrace,
  listClubs,
  listPayments,
  restoreClub,
  rotateApiKey,
  setBlocked,
  updateClub,
} from "./clubs.js";
import {
  authenticateHubUser,
  clearedHubSessionCookie,
  createHubSession,
  createHubUser,
  deleteHubSession,
  hubSessionCookie,
  listHubUsers,
  setHubUserPassword,
} from "./auth.js";
import { HUB_EVENT_LABELS, HubEvent, listHubJournal, logHubEvent } from "./journal.js";
import {
  createMessage,
  createSupportToken,
  deleteMessage,
  listMessages,
  listSupportLogins,
  markMessageRead,
  messagesForClub,
  redeemSupportToken,
} from "./messages.js";
import { createPlan, deletePlan, listPlans, updatePlan } from "./plans.js";
import { attentionList, networkStats } from "./overview.js";

/** Разбирает :id из адреса; null — не число. */
function intParam(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

/**
 * Роутер панели.
 * @param {import("node:sqlite").DatabaseSync} hubDb
 * @param {{liveStats?: (clubs: Array<{id: number}>) => Record<number, object|null>}} [options]
 *   liveStats — живое состояние клубов из их баз; есть только в сети клубов
 */
export function createHubRouter(hubDb, { liveStats = null } = {}) {
  const router = express.Router();

  // --- Программы клубов: отметка на связи ----------------------------------
  //
  // Ответ на «ping» — это и есть механизм автоблокировки: клуб узнаёт из
  // него, оплачен он или нет, и сам показывает предупреждение либо
  // запрещает работу. Панель ничего никуда не «пушит».
  const agent = express.Router();
  agent.use((req, res, next) => {
    const key = req.get("X-Club-Key") ?? req.body?.api_key ?? "";
    const club = clubByApiKey(hubDb, key);
    if (!club) return res.status(401).json({ detail: "Неизвестный ключ клуба" });
    req.club = club;
    next();
  });

  agent.post("/ping", (req, res) => {
    const club = req.club;
    const body = req.body ?? {};
    const wasSilent = !club.last_seen_at;
    hubDb
      .prepare(
        "UPDATE clubs SET last_seen_at = ?, app_version = ?, tables_count = ? WHERE id = ?"
      )
      .run(
        new Date().toISOString(),
        body.version ? String(body.version).slice(0, 40) : club.app_version,
        Number.isInteger(Number(body.tables)) ? Number(body.tables) : club.tables_count,
        club.id
      );
    if (wasSilent) {
      logHubEvent(hubDb, HubEvent.CLUB_ONLINE, `Клуб «${club.name}» впервые вышел на связь`, club.id);
    }
    const fresh = getClub(hubDb, club.id);
    res.json({
      club: { id: fresh.id, name: fresh.name },
      status: fresh.status,
      status_label: fresh.status_label,
      // Главное для клуба: работать можно или нет и до какого числа.
      blocked: fresh.status === "blocked" || fresh.status === "archived",
      paid_until: fresh.paid_until,
      days_left: fresh.days_left,
      plan_name: fresh.plan_name,
      max_tables:
        hubDb.prepare("SELECT max_tables FROM plans WHERE id = ?").get(fresh.plan_id ?? -1)
          ?.max_tables ?? null,
      messages: messagesForClub(hubDb, club.id),
    });
  });

  agent.post("/messages/:id/read", (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Сообщение не найдено" });
    res.json(markMessageRead(hubDb, req.club.id, id));
  });

  agent.post("/support/redeem", (req, res) => {
    res.json(redeemSupportToken(hubDb, req.club.id, req.body?.token));
  });

  router.use("/api/agent", agent);

  // --- Вход в панель -------------------------------------------------------

  router.post("/api/auth/login", (req, res) => {
    const user = authenticateHubUser(hubDb, req.body?.login, req.body?.password);
    if (!user) return res.status(401).json({ detail: "Неверный логин или пароль" });
    res.setHeader("Set-Cookie", hubSessionCookie(createHubSession(hubDb, user.id)));
    res.json(user);
  });

  router.post("/api/auth/logout", (req, res) => {
    deleteHubSession(hubDb, req.hubToken);
    res.setHeader("Set-Cookie", clearedHubSessionCookie());
    res.json({ ok: true });
  });

  router.get("/api/auth/me", (req, res) => {
    if (!req.hubUser) return res.status(401).json({ detail: "Требуется вход" });
    res.json(req.hubUser);
  });

  // Дальше — только для вошедших в панель.
  router.use("/api", (req, res, next) => {
    if (!req.hubUser) return res.status(401).json({ detail: "Требуется вход" });
    next();
  });

  // --- Сводка --------------------------------------------------------------

  router.get("/api/overview", (req, res) => {
    res.json({
      stats: networkStats(hubDb),
      attention: attentionList(hubDb),
      settings: hubSettings(hubDb),
    });
  });

  // Что происходит в клубах прямо сейчас: столы, выручка за день, смена,
  // молчащие реле — из баз клубов, без пингов. Пустой ответ — панель
  // стоит у одиночного клуба, чужих баз у неё нет.
  router.get("/api/live", (req, res) => {
    if (!liveStats) return res.json({});
    res.json(liveStats(listClubs(hubDb, { status: "all" })));
  });

  // --- Клубы ---------------------------------------------------------------

  router.get("/api/clubs", (req, res) => {
    res.json(
      listClubs(hubDb, {
        status: String(req.query.status ?? ""),
        query: String(req.query.query ?? ""),
      })
    );
  });

  router.post("/api/clubs", (req, res) => {
    res.status(201).json(createClub(hubDb, req.body ?? {}, req.hubUser));
  });

  /** Общий разбор :id клуба для всех вложенных маршрутов. */
  const withClub = (handler) => (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Клуб не найден" });
    return handler(req, res, id);
  };

  router.get("/api/clubs/:id", withClub((req, res, id) => res.json(getClub(hubDb, id))));

  router.put(
    "/api/clubs/:id",
    withClub((req, res, id) => res.json(updateClub(hubDb, id, req.body ?? {}, req.hubUser)))
  );

  router.get(
    "/api/clubs/:id/payments",
    withClub((req, res, id) => res.json(listPayments(hubDb, id)))
  );

  router.post(
    "/api/clubs/:id/payments",
    withClub((req, res, id) =>
      res.status(201).json(addPayment(hubDb, id, req.body ?? {}, req.hubUser))
    )
  );

  router.post(
    "/api/clubs/:id/grace",
    withClub((req, res, id) => res.json(grantGrace(hubDb, id, req.body?.days, req.hubUser)))
  );

  router.post(
    "/api/clubs/:id/block",
    withClub((req, res, id) =>
      res.json(setBlocked(hubDb, id, req.body?.blocked !== false, req.hubUser))
    )
  );

  router.post(
    "/api/clubs/:id/archive",
    withClub((req, res, id) => res.json(archiveClub(hubDb, id, req.hubUser)))
  );

  router.post(
    "/api/clubs/:id/restore",
    withClub((req, res, id) => res.json(restoreClub(hubDb, id, req.hubUser)))
  );

  router.post(
    "/api/clubs/:id/key",
    withClub((req, res, id) => res.json(rotateApiKey(hubDb, id, req.hubUser)))
  );

  router.post(
    "/api/clubs/:id/support",
    withClub((req, res, id) =>
      res.status(201).json(createSupportToken(hubDb, id, req.body?.reason, req.hubUser))
    )
  );

  router.get("/api/support", (req, res) => {
    const clubId = req.query.club_id ? intParam(req.query.club_id) : null;
    res.json(listSupportLogins(hubDb, clubId));
  });

  // --- Тарифы сервиса ------------------------------------------------------

  router.get("/api/plans", (req, res) => res.json(listPlans(hubDb)));

  router.post("/api/plans", (req, res) => {
    res.status(201).json(createPlan(hubDb, req.body ?? {}, req.hubUser));
  });

  router.put("/api/plans/:id", (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Тариф не найден" });
    res.json(updatePlan(hubDb, id, req.body ?? {}, req.hubUser));
  });

  router.delete("/api/plans/:id", (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Тариф не найден" });
    res.json(deletePlan(hubDb, id));
  });

  // --- Сообщения клубам ----------------------------------------------------

  router.get("/api/messages", (req, res) => res.json(listMessages(hubDb)));

  router.post("/api/messages", (req, res) => {
    res.status(201).json(createMessage(hubDb, req.body ?? {}, req.hubUser));
  });

  router.delete("/api/messages/:id", (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Сообщение не найдено" });
    res.json(deleteMessage(hubDb, id));
  });

  // --- Журнал сети ---------------------------------------------------------

  router.get("/api/journal", (req, res) => {
    res.json({
      entries: listHubJournal(hubDb, {
        clubId: req.query.club_id ? intParam(req.query.club_id) : null,
        event: String(req.query.event ?? ""),
      }),
      labels: HUB_EVENT_LABELS,
    });
  });

  // --- Настройки и сотрудники панели ---------------------------------------

  router.get("/api/settings", (req, res) => {
    res.json({ settings: hubSettings(hubDb), users: listHubUsers(hubDb) });
  });

  router.put("/api/settings", (req, res) => {
    res.json(saveHubSettings(hubDb, req.body ?? {}));
  });

  router.post("/api/users", (req, res) => {
    res.status(201).json(createHubUser(hubDb, req.body ?? {}));
  });

  router.post("/api/users/:id/password", (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return res.status(404).json({ detail: "Сотрудник не найден" });
    res.json(setHubUserPassword(hubDb, id, req.body?.password));
  });

  // Ошибки панели переводим в те же коды, что и в клубном API.
  // eslint-disable-next-line no-unused-vars -- четыре аргумента обязательны для Express
  router.use((err, req, res, next) => {
    if (err instanceof ForbiddenError) return res.status(403).json({ detail: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ detail: err.message });
    if (err instanceof ConflictError) return res.status(409).json({ detail: err.message });
    return next(err);
  });

  return router;
}
