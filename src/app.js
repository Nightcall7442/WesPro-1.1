// Сборка Express-приложения. Вынесена в фабрику, чтобы тесты могли
// создавать приложение со своей базой, не поднимая сетевой сервер.

import express from "express";
import path from "node:path";

import { PUBLIC_DIR } from "./config.js";
import { createApiRouter } from "./routes/api.js";
import { getUserByToken, tokenFromCookieHeader } from "./services/auth.js";
import { logServerError } from "./services/diagnostics.js";
import { requestLogger } from "./services/request-log.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./services/errors.js";

/** @param {import("node:sqlite").DatabaseSync} db */
export function createApp(db) {
  const app = express();
  // Загрузка резервной копии — сырой файл .db в теле запроса. Разбирается
  // до express.json, чтобы JSON-парсер не пытался читать двоичные данные.
  app.use(
    "/api/backup/import",
    express.raw({ type: () => true, limit: "256mb" })
  );
  // Логотип клуба приходит как data-URI внутри JSON, поэтому лимит по
  // умолчанию (100 КБ) пришлось поднять.
  app.use(express.json({ limit: "8mb" }));

  // Кто делает запрос: пользователь по токену из HttpOnly-cookie.
  app.use((req, res, next) => {
    req.authToken = tokenFromCookieHeader(req.headers.cookie);
    req.user = getUserByToken(db, req.authToken);
    next();
  });

  // Журнал последних запросов: «что нажимали и чем это кончилось».
  // Ставится после определения пользователя, чтобы в записи было имя.
  app.use(requestLogger());

  app.get("/", (req, res) => {
    if (!req.user) return res.redirect("/login");
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  app.get("/login", (req, res) => {
    if (req.user) return res.redirect("/");
    res.sendFile(path.join(PUBLIC_DIR, "login.html"));
  });

  // Экран для гостей: телевизор в зале со свободными столами и ценами.
  // Открывается без входа — на нём нет ни денег, ни имён клиентов.
  app.get("/board", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "board.html"));
  });

  app.use("/static", express.static(PUBLIC_DIR));

  // Всё API, кроме входа и названия/логотипа клуба (их показывает страница
  // входа — до авторизации), требует авторизации.
  const PUBLIC_API_PATHS = new Set(["/auth/login", "/brand", "/board"]);
  app.use("/api", (req, res, next) => {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ detail: "Требуется вход" });
    next();
  });
  app.use("/api", createApiRouter(db));

  // Доменные ошибки -> HTTP-коды; формат тела как у остального API.
  // eslint-disable-next-line no-unused-vars -- сигнатура из 4 аргументов обязательна для Express
  app.use((err, req, res, next) => {
    if (err instanceof UnauthorizedError) {
      return res.status(401).json({ detail: err.message });
    }
    if (err instanceof ForbiddenError) {
      return res.status(403).json({ detail: err.message });
    }
    if (err instanceof NotFoundError) {
      return res.status(404).json({ detail: err.message });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({ detail: err.message });
    }
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ detail: "Некорректный JSON в теле запроса" });
    }
    // Неожиданная ошибка: пишем в logs/errors.log и показываем причину
    // в ответе. Раньше в браузер уходило только «Внутренняя ошибка
    // сервера», а настоящая причина оставалась в свёрнутом окне сервера —
    // разобраться было невозможно.
    console.error(err);
    const { message } = logServerError(err, req);
    return res.status(500).json({
      detail: `Внутренняя ошибка сервера: ${message}`,
      reason: message,
    });
  });

  return app;
}
