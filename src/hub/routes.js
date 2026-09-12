// Маршруты центральной панели. Две независимые части:
//
// • /hub/api/…       — панель владельца сервиса (вход по cookie);
// • /hub/api/agent/… — программы самих клубов (вход по ключу клуба).
//
// Разделение принципиальное: клуб своим ключом может только отметиться
// на связи и забрать сообщения. Ни списка соседей, ни чужих оплат он не
// видит — ключ утёк бы вместе с компьютером клуба.

import express from "express";
import fs from "node:fs";

import { backupFileName, exportBackupFile } from "../services/backup.js";
import { exeInfo, saveExe } from "../services/downloads.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../services/errors.js";
import { listJournal } from "../services/journal.js";
import { currentVersion } from "../services/diagnostics.js";
import { FEATURES, featuresForVersion, versionOf, versionSteps } from "../services/features.js";
import { enabledFeatures, getClubSettings, setFeatures } from "../services/settings.js";
import { closeShift } from "../services/shifts.js";
import { listUsers, updateUser } from "../services/users.js";
import { clubLiveDetail, clubLiveStats } from "./live.js";
import { createMirrors } from "./mirrors.js";
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
 * @param {{
 *   tenantDb?: (club: {id: number}) => import("node:sqlite").DatabaseSync | null,
 *   openClubProgram?: (club: object, hubUser: object, res: import("express").Response) => void,
 *   mirrors?: ReturnType<typeof createMirrors>,
 * }} [options] хуки сети клубов: база облачного клуба по карточке и вход
 *   в его программу — у одиночной установки их нет. Снимки офлайн-клубов
 *   (mirrors) есть в обоих режимах.
 */
export function createHubRouter(
  hubDb,
  { tenantDb = null, openClubProgram = null, mirrors = createMirrors() } = {}
) {
  const router = express.Router();

  /**
   * База клуба для панели: облачный клуб — его база в этом же процессе
   * (не закрывать), офлайн-клуб — его снимок (открыть и закрыть). null —
   * клуб ещё ни разу не выходил на связь.
   * @returns {{db: import("node:sqlite").DatabaseSync, mirror: boolean, close: () => void} | null}
   */
  const resolveClubDb = (club) => {
    const tenant = tenantDb ? tenantDb(club) : null;
    if (tenant) return { db: tenant, mirror: false, close: () => {} };
    const snapshot = mirrors.open(club);
    if (snapshot) return { db: snapshot, mirror: true, close: mirrors.closer(snapshot) };
    return null;
  };

  /** Что-то сделать с базой клуба и обязательно закрыть снимок. */
  const withClubDb = (club, fn) => {
    const handle = resolveClubDb(club);
    if (!handle) return null;
    try {
      return fn(handle.db, handle.mirror);
    } finally {
      handle.close();
    }
  };

  /** Новшества клуба: облачному — в базу, офлайновому — ещё и в панель (уедут с ping). */
  const applyFeatures = (club, db, mirror, patch) => {
    const enabled = setFeatures(db, patch);
    if (mirror) {
      hubDb.prepare("UPDATE clubs SET features_json = ? WHERE id = ?").run(JSON.stringify(enabled), club.id);
    }
    return enabled;
  };

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
      // Что панель включила клубу (обновления по клубам) — клуб применит.
      features: (() => {
        const row = hubDb.prepare("SELECT features_json FROM clubs WHERE id = ?").get(club.id);
        return row?.features_json ? JSON.parse(row.features_json) : null;
      })(),
    });
  });

  // Снимок базы офлайн-клуба (см. services/sync.js): по нему панель
  // показывает клуб как облачный. Облачному клубу снимки не нужны.
  agent.post("/snapshot", (req, res) => {
    const club = req.club;
    if (tenantDb && tenantDb(club)) {
      return res.status(409).json({ detail: "Этот клуб работает в облаке — снимки ему не нужны" });
    }
    const result = mirrors.save(club, req.body);
    hubDb.prepare("UPDATE clubs SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), club.id);
    res.json(result);
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
    const out = {};
    for (const club of listClubs(hubDb, { status: "all" })) {
      out[club.id] = withClubDb(club, (db, mirror) => {
        const stats = clubLiveStats(db);
        if (mirror) {
          stats.mirror = true;
          stats.snapshot_at = mirrors.snapshotAt(club);
        } else if (stats.last_activity_at && stats.last_activity_at > (club.last_seen_at ?? "")) {
          // Облачный клуб не «отмечается» пингом — программа общая. Его
          // связь — это его же работа: последняя запись в журнале клуба
          // и есть «был на связи», а версия у всех одна, серверная.
          hubDb
            .prepare("UPDATE clubs SET last_seen_at = ?, app_version = ?, tables_count = ? WHERE id = ?")
            .run(stats.last_activity_at, currentVersion(), stats.tables_total, club.id);
        }
        return stats;
      });
    }
    res.json(out);
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

  // --- Программа клуба: управление из панели --------------------------------
  //
  // В сети клубов база каждого клуба под рукой, и владелец сети может
  // не только смотреть подписку, но и заглянуть внутрь: столы и реле
  // сейчас, сотрудники, журнал, копия базы. Права — как у разработчика
  // клуба: это и есть поддержка, только без одноразовых ключей. Каждое
  // действие подписывается «Панель сети: имя».
  const program = express.Router({ mergeParams: true });
  program.use((req, res, next) => {
    const id = intParam(req.params.id);
    const club = id === null ? null : getClub(hubDb, id);
    if (!club) return res.status(404).json({ detail: "Клуб не найден" });
    const handle = resolveClubDb(club);
    if (!handle) {
      return res.status(404).json({
        detail: "Клуб ещё не выходил на связь — ни базы в облаке, ни снимка",
      });
    }
    req.club = club;
    req.clubDb = handle.db;
    req.clubMirror = handle.mirror;
    res.on("finish", handle.close);
    res.on("close", handle.close);
    req.author = { id: 0, name: `Панель сети: ${req.hubUser.name}`, role: "developer" };
    next();
  });

  // Снимок — только для чтения: правка в нём до клуба не дойдёт.
  const readOnlyForMirror = (req, res, next) => {
    if (req.clubMirror) {
      throw new ConflictError(
        "Клуб работает у себя, панель видит только снимок его базы — это делается в самой программе клуба"
      );
    }
    next();
  };

  program.get("/live", (req, res) => {
    res.json({
      ...clubLiveDetail(req.clubDb),
      settings: getClubSettings(req.clubDb),
      mirror: req.clubMirror,
      snapshot_at: req.clubMirror ? mirrors.snapshotAt(req.club) : null,
    });
  });

  program.get("/users", (req, res) => {
    res.json(listUsers(req.clubDb));
  });

  // Сброс пароля, отключение, роль — то же, что делает владелец клуба у себя.
  program.put("/users/:uid", readOnlyForMirror, (req, res) => {
    const uid = intParam(req.params.uid);
    if (uid === null) return res.status(404).json({ detail: "Сотрудник не найден" });
    const body = req.body ?? {};
    const patch = {};
    for (const key of ["name", "role", "is_active", "password"]) {
      if (key in body) patch[key] = body[key];
    }
    const user = updateUser(req.clubDb, uid, patch, req.author);
    logHubEvent(
      hubDb,
      HubEvent.CLUB_UPDATED,
      `«${req.club.name}»: изменён сотрудник ${user.login}` +
        `${"password" in patch ? " (новый пароль)" : ""} — ${req.hubUser.name}`,
      req.club.id
    );
    res.json(user);
  });

  program.get("/journal", (req, res) => {
    res.json(listJournal(req.clubDb, 100));
  });

  // Новшества клуба: что включено. Так обновление раскатывается по
  // клубам по одному — код общий, а видит клуб только то, что ему
  // включили.
  const featuresOut = (db) => {
    const enabled = enabledFeatures(db);
    return {
      features: FEATURES,
      enabled,
      versions: versionSteps(currentVersion()),
      version: versionOf(enabled, currentVersion()),
      current_version: currentVersion(),
    };
  };

  program.get("/features", (req, res) => {
    res.json(featuresOut(req.clubDb));
  });

  // Либо по одному новшеству ({devices: false}), либо ступенью
  // ({version: "1.14.0"}): включить всё до этой версии, остальное выключить.
  program.put("/features", (req, res) => {
    const body = req.body ?? {};
    let patch = body;
    let what;
    if ("version" in body) {
      const step = versionSteps(currentVersion()).find((s) => s.version === String(body.version));
      if (!step) throw new ConflictError(`Версии «${body.version}» нет в списке ступеней`);
      patch = featuresForVersion(step.version);
      what = `поставлена версия ${step.version}`;
    } else {
      what = FEATURES.filter((f) => f.key in patch)
        .map((f) => `${f.label}: ${patch[f.key] ? "вкл" : "выкл"}`)
        .join(", ") || "без изменений";
    }
    applyFeatures(req.club, req.clubDb, req.clubMirror, patch);
    logHubEvent(
      hubDb,
      HubEvent.CLUB_UPDATED,
      `«${req.club.name}»: обновления — ${what} — ${req.hubUser.name}`,
      req.club.id
    );
    res.json(featuresOut(req.clubDb));
  });

  // Смена, которую забыли закрыть: закрывается от имени того, кто её открыл.
  program.post("/shift/close", readOnlyForMirror, (req, res) => {
    const open = req.clubDb
      .prepare(
        `SELECT s.user_id, u.name FROM shifts s JOIN users u ON u.id = s.user_id
         WHERE s.closed_at IS NULL ORDER BY s.opened_at DESC LIMIT 1`
      )
      .get();
    if (!open) throw new ConflictError("Открытой смены нет — закрывать нечего");
    const shift = closeShift(req.clubDb, { id: open.user_id, name: `${open.name} (закрыто панелью сети)` });
    logHubEvent(
      hubDb,
      HubEvent.CLUB_UPDATED,
      `«${req.club.name}»: смена ${open.name} закрыта из панели — ${req.hubUser.name}`,
      req.club.id
    );
    res.json(shift);
  });

  program.get("/backup", (req, res) => {
    const target = exportBackupFile(req.clubDb);
    logHubEvent(
      hubDb,
      HubEvent.SUPPORT_LOGIN,
      `«${req.club.name}»: скачана копия базы — ${req.hubUser.name}`,
      req.club.id
    );
    res.download(target, backupFileName(), () => {
      fs.unlink(target, () => {});
    });
  });

  // Вход в программу клуба в один клик — разработчиком поддержки (свой
  // аккаунт у каждого сотрудника панели). Попадает в журнал сети и в
  // журнал клуба, а клуб видит предупреждение, пока разработчик внутри.
  program.get("/open", (req, res) => {
    if (!openClubProgram || req.clubMirror) {
      return res.status(409).json({
        detail: "Клуб работает у себя — войти в него можно только ключом поддержки",
      });
    }
    logHubEvent(
      hubDb,
      HubEvent.SUPPORT_LOGIN,
      `Вход в программу «${req.club.name}» из панели сети — ${req.hubUser.name}`,
      req.club.id
    );
    openClubProgram(req.club, req.hubUser, res);
  });

  router.use("/api/clubs/:id/program", program);

  // Новшества по всей сети: у скольких клубов включено, включить или
  // выключить всем разом. Клубы без базы не считаются — им нечего включать.
  /** Клубы, у которых есть база (облако) или снимок: {club, enabled}. */
  const clubsWithDb = (fn = null) => {
    const rows = [];
    for (const club of listClubs(hubDb, { status: "all" })) {
      if (club.status === "archived") continue;
      const enabled = withClubDb(club, (db, mirror) => (fn ? fn(club, db, mirror) : enabledFeatures(db)));
      if (enabled) rows.push({ club, enabled });
    }
    return rows;
  };

  router.get("/api/features", (req, res) => {
    const rows = clubsWithDb();
    res.json({
      clubs_total: rows.length,
      current_version: currentVersion(),
      versions: versionSteps(currentVersion()),
      features: FEATURES.map((f) => ({
        ...f,
        enabled_count: rows.filter(({ enabled }) => enabled[f.key]).length,
      })),
    });
  });

  // Поставить версию всем клубам разом.
  router.put("/api/features/version", (req, res) => {
    const step = versionSteps(currentVersion()).find((s) => s.version === String(req.body?.version));
    if (!step) throw new ConflictError(`Версии «${req.body?.version}» нет в списке ступеней`);
    const rows = clubsWithDb((club, db, mirror) => applyFeatures(club, db, mirror, featuresForVersion(step.version)));
    logHubEvent(
      hubDb,
      HubEvent.CLUB_UPDATED,
      `Всем клубам (${rows.length}) поставлена версия ${step.version} — ${req.hubUser.name}`
    );
    res.json({ updated: rows.length, version: step.version });
  });

  router.put("/api/features/:key", (req, res) => {
    const feature = FEATURES.find((f) => f.key === req.params.key);
    if (!feature) return res.status(404).json({ detail: "Такого новшества нет" });
    const enabled = Boolean(req.body?.enabled);
    const rows = clubsWithDb((club, db, mirror) => applyFeatures(club, db, mirror, { [feature.key]: enabled }));
    logHubEvent(
      hubDb,
      HubEvent.CLUB_UPDATED,
      `Всем клубам (${rows.length}): «${feature.label}» ${enabled ? "включено" : "выключено"} — ${req.hubUser.name}`
    );
    res.json({ updated: rows.length, enabled });
  });

  // --- WesPro.exe для клубов -------------------------------------------------
  // Собирается на Windows (npm run build:exe) и загружается сюда; клубы
  // скачивают его из своих «Настроек» по /download/WesPro.exe.

  router.get("/api/exe", (req, res) => {
    res.json({ exe: exeInfo() });
  });

  router.post("/api/exe", (req, res) => {
    const info = saveExe(req.body, {
      version: req.get("X-Version") ?? "",
      by: req.hubUser.name,
    });
    logHubEvent(
      hubDb,
      HubEvent.CLUB_UPDATED,
      `Загружен WesPro.exe версии ${info.version} (${(info.size / 1024 / 1024).toFixed(1)} МБ) — ${req.hubUser.name}`
    );
    res.json({ exe: info });
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
