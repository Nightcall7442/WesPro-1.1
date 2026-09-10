// Разделы, общие для обоих режимов работы: панель сети клубов (/hub) и
// личный кабинет владельца клуба (/account).
//
// Одиночная установка подключает их к своему приложению (src/app.js),
// сеть — к общему приложению-диспетчеру (src/network.js). Код один и
// тот же, чтобы вход в кабинет не разъехался между режимами.

import express from "express";
import path from "node:path";

import { PUBLIC_DIR } from "../config.js";
import { createAccountRouter } from "./account-routes.js";
import { accountTokenFromCookie, clubByToken } from "./account.js";
import { hubTokenFromCookie, hubUserByToken } from "./auth.js";
import { createHubRouter } from "./routes.js";

/**
 * @param {import("express").Express} app
 * @param {import("node:sqlite").DatabaseSync} hubDb
 * @param {Parameters<typeof createAccountRouter>[1]} [accountOptions]
 */
export function mountHubAndAccount(app, hubDb, accountOptions = {}) {
  // Свой разбор тела: в сети общее приложение не парсит JSON глобально —
  // загрузка резервной копии клуба приходит сырым файлом.
  app.use("/hub", express.json({ limit: "1mb" }));
  app.use("/account", express.json({ limit: "1mb" }));

  // --- Центральная панель сети клубов ---------------------------------------
  // Свой вход, своя cookie, своя база: сотрудник клуба сюда не попадает
  // даже с действующей сессией клуба.
  app.use("/hub", (req, res, next) => {
    req.hubToken = hubTokenFromCookie(req.headers.cookie);
    req.hubUser = hubUserByToken(hubDb, req.hubToken);
    next();
  });
  app.get("/hub", (req, res) => {
    if (!req.hubUser) return res.redirect("/hub/login");
    res.sendFile(path.join(PUBLIC_DIR, "hub.html"));
  });
  app.get("/hub/login", (req, res) => {
    if (req.hubUser) return res.redirect("/hub");
    res.sendFile(path.join(PUBLIC_DIR, "hub-login.html"));
  });
  app.use("/hub", createHubRouter(hubDb));

  // --- Личный кабинет владельца клуба ---------------------------------------
  // Тоже своя cookie (Path=/account), поэтому и вход, и API — на своём
  // префиксе: cookie с одним путём браузер на другой не пошлёт.
  app.use("/account", (req, res, next) => {
    req.accountToken = accountTokenFromCookie(req.headers.cookie);
    req.accountClub = clubByToken(hubDb, req.accountToken);
    next();
  });
  app.get("/account", (req, res) => {
    if (!req.accountClub) return res.redirect("/account/login");
    res.sendFile(path.join(PUBLIC_DIR, "account.html"));
  });
  app.get("/account/login", (req, res) => {
    if (req.accountClub) return res.redirect("/account");
    res.sendFile(path.join(PUBLIC_DIR, "account-login.html"));
  });
  app.get("/account/register", (req, res) => {
    if (req.accountClub) return res.redirect("/account");
    res.sendFile(path.join(PUBLIC_DIR, "account-register.html"));
  });
  app.use("/account", createAccountRouter(hubDb, accountOptions));
}
