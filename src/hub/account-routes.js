// Маршруты личного кабинета владельца клуба: регистрация, вход по почте
// и паролю, карточка своего клуба. Отдельный роутер от панели сети
// (/hub) — у кабинета своя cookie с Path=/account, поэтому и API у него
// на своём префиксе, а не внутри /hub/api.

import express from "express";

import { ConflictError, NotFoundError, UnauthorizedError } from "../services/errors.js";
import {
  accountSessionCookie,
  accountView,
  authenticateClub,
  changeClubPassword,
  clearedAccountSessionCookie,
  createClubSession,
  deleteClubSession,
  registerClub,
} from "./account.js";

/**
 * @param {import("node:sqlite").DatabaseSync} hubDb
 * @param {{openProgram?: import("express").RequestHandler,
 *          onPasswordChanged?: (clubId: number) => void}} [options]
 *   openProgram — переход из кабинета сразу в программу клуба (только в
 *   сетевом режиме: в одиночной установке программа и так одна).
 *   onPasswordChanged — пароль владельца поменялся; в сети им же
 *   открывается программа, поэтому там его надо обновить и в базе клуба.
 */
export function createAccountRouter(hubDb, { openProgram = null, onPasswordChanged = null } = {}) {
  const router = express.Router();

  if (openProgram) router.get("/open", openProgram);

  router.post("/api/register", (req, res) => {
    const club = registerClub(hubDb, req.body ?? {});
    res.setHeader("Set-Cookie", accountSessionCookie(createClubSession(hubDb, club.id)));
    res.status(201).json(club);
  });

  router.post("/api/login", (req, res) => {
    const club = authenticateClub(hubDb, req.body?.email, req.body?.password);
    if (!club) return res.status(401).json({ detail: "Неверная почта или пароль" });
    res.setHeader("Set-Cookie", accountSessionCookie(createClubSession(hubDb, club.id)));
    res.json({ id: club.id, name: club.name });
  });

  router.post("/api/logout", (req, res) => {
    deleteClubSession(hubDb, req.accountToken);
    res.setHeader("Set-Cookie", clearedAccountSessionCookie());
    res.json({ ok: true });
  });

  router.get("/api/me", (req, res) => {
    if (!req.accountClub) return res.status(401).json({ detail: "Требуется вход" });
    res.json({ id: req.accountClub.id, name: req.accountClub.name });
  });

  // Дальше — только для вошедшего в кабинет клуба.
  router.use("/api", (req, res, next) => {
    if (!req.accountClub) return res.status(401).json({ detail: "Требуется вход" });
    next();
  });

  router.get("/api/account", (req, res) => {
    res.json(accountView(hubDb, req.accountClub.id));
  });

  router.post("/api/password", (req, res) => {
    const result = changeClubPassword(
      hubDb,
      req.accountClub.id,
      req.body?.old_password,
      req.body?.new_password
    );
    onPasswordChanged?.(req.accountClub.id);
    res.json(result);
  });

  // eslint-disable-next-line no-unused-vars -- четыре аргумента обязательны для Express
  router.use((err, req, res, next) => {
    if (err instanceof UnauthorizedError) return res.status(401).json({ detail: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ detail: err.message });
    if (err instanceof ConflictError) return res.status(409).json({ detail: err.message });
    return next(err);
  });

  return router;
}

