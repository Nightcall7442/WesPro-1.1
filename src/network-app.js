// Сеть клубов: один сервер, много клубов, у каждого своя база.
//
// Это приложение само по себе ничего не умеет — оно только решает, чей
// запрос перед ним, и отдаёт его программе нужного клуба (src/tenants.js).
// Общее у всех клубов — витрина, панель сети и личный кабинет.
//
// Как браузер сообщает, в какой клуб идёт запрос. В cookie wespro_club
// лежит адрес клуба в сети. Он попадает туда одним из трёх способов:
//   • владелец нажал в кабинете «Открыть программу»;
//   • сотрудник открыл ссылку своего клуба /login?club=…;
//   • владелец ввёл на входе почту, которой регистрировал клуб.
// Ни в одном из случаев cookie сама по себе никуда не пускает: она лишь
// выбирает клуб, а дальше работает обычный вход по логину и паролю.

import express from "express";
import path from "node:path";

import { landingAtRoot, PUBLIC_DIR } from "./config.js";
import { clubByCode, clubByEmail, statusFor } from "./hub/clubs.js";
import { hubNumber } from "./hub/db.js";
import { mountHubAndAccount } from "./hub/mount.js";
import { createAuthSession, sessionCookie } from "./services/auth.js";
import { createTenants } from "./tenants.js";

const TENANT_COOKIE = "wespro_club";
// Долго: смена клуба на одном устройстве — редкость, а вот заново искать
// ссылку своего клуба каждый месяц кассиру не хочется.
const TENANT_DAYS = 365;

function tenantCookie(code) {
  return (
    `${TENANT_COOKIE}=${code}; HttpOnly; Path=/; SameSite=Lax; ` +
    `Max-Age=${TENANT_DAYS * 86400}`
  );
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

/**
 * Добавляет свою cookie к тем, что поставит программа клуба.
 *
 * Обработчик входа ставит cookie сессии через res.setHeader — а он
 * заменяет заголовок целиком. Поэтому подмешиваемся к вызову: cookie
 * клуба ставится ровно тогда, когда вход удался, и не остаётся на
 * устройстве после неудачной попытки.
 */
function alsoSetCookie(res, cookie) {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() !== "set-cookie") return setHeader(name, value);
    return setHeader(name, [...(Array.isArray(value) ? value : [value]), cookie]);
  };
}

/**
 * @param {import("node:sqlite").DatabaseSync} hubDb
 * @param {{tenants?: ReturnType<typeof createTenants>}} [options]
 */
export function createNetworkApp(hubDb, { tenants = createTenants(hubDb) } = {}) {
  const app = express();
  const page = (name) => path.join(PUBLIC_DIR, name);

  // Статус считаем из дат при каждом запросе, а не читаем сохранённый:
  // клуб, у которого вчера кончилась оплата, должен упереться в неё
  // сегодня, а не тогда, когда кто-нибудь откроет панель сети.
  const statusOf = (club) => statusFor(club, { graceDays: hubNumber(hubDb, "grace_days") });

  app.use((req, res, next) => {
    const code = readCookie(req.headers.cookie, TENANT_COOKIE);
    req.club = code ? clubByCode(hubDb, code) : null;
    next();
  });

  app.use("/static", express.static(PUBLIC_DIR));
  app.get("/about", (req, res) => res.sendFile(page("landing.html")));

  mountHubAndAccount(app, hubDb, {
    onPasswordChanged: (clubId) => tenants.syncOwnerPassword(clubId),
    // Из кабинета — сразу в программу: владелец уже доказал, кто он,
    // второй раз спрашивать тот же пароль незачем.
    openProgram: (req, res) => {
      if (!req.accountClub) return res.redirect("/account/login");
      const owner = tenants.ownerUser(req.accountClub);
      if (!owner) {
        return res
          .status(409)
          .send("Программа клуба ещё не заведена: обратитесь в поддержку WesPro.");
      }
      const token = createAuthSession(tenants.for(req.accountClub).db, owner.id);
      res.setHeader("Set-Cookie", [
        tenantCookie(req.accountClub.code),
        sessionCookie(token),
      ]);
      res.redirect("/");
    },
  });

  // Ссылка клуба для сотрудников: /login?club=<код>. Запомнили клуб —
  // дальше обычная страница входа этого клуба.
  app.get("/login", (req, res, next) => {
    const code = String(req.query.club ?? "").trim();
    if (!code) return next();
    const club = clubByCode(hubDb, code);
    // Неизвестный код — не на витрину: человек шёл на работу, а не
    // читать про систему. Возвращаем на вход с понятной причиной.
    if (!club) return res.redirect("/login?unknown_club=1");
    res.setHeader("Set-Cookie", tenantCookie(club.code));
    res.redirect("/login");
  });

  // Вход с чистого устройства: клуб ещё не выбран, но по почте владельца
  // понятно, какой это клуб. Сам пароль проверяет программа клуба —
  // здесь только маршрутизация.
  app.post("/api/auth/login", express.json({ limit: "1mb" }), (req, res, next) => {
    if (req.club) return next();
    const club = clubByEmail(hubDb, req.body?.login);
    if (!club) {
      return res.status(401).json({
        detail:
          "Это вход по почте владельца клуба. Сотрудникам — кнопка " +
          "«Войти по коду клуба» ниже: код даёт владелец",
      });
    }
    req.club = club;
    alsoSetCookie(res, tenantCookie(club.code));
    next();
  });

  // Всё остальное — программа того клуба, чей код в cookie.
  app.use((req, res, next) => {
    if (!req.club) return next();
    const status = statusOf(req.club);
    if (status === "blocked" || status === "archived") {
      const detail = "Подписка на WesPro приостановлена. Оплатите её в личном кабинете.";
      if (req.path.startsWith("/api/")) return res.status(402).json({ detail });
      return res.status(402).sendFile(page("paused.html"));
    }
    tenants.for(req.club).app(req, res);
  });

  // Клуб не выбран: витрина, вход по почте и регистрация.
  app.get("/", (req, res) => {
    if (landingAtRoot()) return res.sendFile(page("landing.html"));
    res.redirect("/login");
  });
  app.get("/login", (req, res) => res.sendFile(page("login.html")));
  // Страница входа спрашивает, как называется клуб. Клуб ещё не выбран,
  // поэтому отвечаем за сеть — и заодно сообщаем странице, что войти
  // здесь можно почтой.
  app.get("/api/brand", (req, res) => {
    res.json({ club_name: "WesPro", club_logo: "", club_logo_height: 28, network: true });
  });
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ detail: "Клуб не выбран: войдите по почте" });
    }
    res.redirect("/");
  });

  return app;
}
