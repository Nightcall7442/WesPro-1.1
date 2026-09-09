// Общие помощники тестов: приложение с чистой базой в памяти и
// авторизованные агенты (админ и кассир). Сидинг не используется —
// база пустая и предсказуемая, администратора создаём сами.

import supertest from "supertest";

import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createUser } from "../src/services/users.js";

export const ADMIN = { login: "admin", password: "admin1", name: "Админ Тестович" };
export const CASHIER = { login: "kassir", password: "1234", name: "Кассир Иван" };
export const DEVELOPER = { login: "dev", password: "dev12345", name: "Разработчик Тестович" };

/** Свежая база в памяти + Express-приложение + учётка администратора. */
export function makeApp() {
  const db = createDatabase(":memory:");
  createUser(db, { ...ADMIN, role: "admin" });
  return { db, app: createApp(db) };
}

/**
 * Агент, вошедший администратором (cookie сохраняется автоматически).
 * По умолчанию сразу открывает кассовую смену: без неё столы открывать
 * нельзя никому, кроме владельца и разработчика. Передайте
 * { withShift: false }, чтобы проверить именно это ограничение.
 */
export async function adminAgent(app, { withShift = true } = {}) {
  const agent = supertest.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ login: ADMIN.login, password: ADMIN.password });
  if (res.status !== 200) throw new Error(`admin login: ${res.status}`);
  if (withShift) {
    const shift = await agent.post("/api/shifts/open").send({});
    if (shift.status !== 201) throw new Error(`admin shift: ${shift.status}`);
  }
  return agent;
}

/** Создаёт кассира и возвращает вошедшего им агента. */
export async function cashierAgent(app, db) {
  createUser(db, { ...CASHIER, role: "cashier" });
  const agent = supertest.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ login: CASHIER.login, password: CASHIER.password });
  if (res.status !== 200) throw new Error(`cashier login: ${res.status}`);
  return agent;
}

/**
 * Создаёт разработчика и возвращает вошедшего им агента. Нужен для
 * инструментов, доступных только этой роли: настройка реле, демо-данные,
 * SQL-консоль и т. п.
 */
export async function developerAgent(app, db) {
  createUser(db, { ...DEVELOPER, role: "developer" });
  const agent = supertest.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ login: DEVELOPER.login, password: DEVELOPER.password });
  if (res.status !== 200) throw new Error(`developer login: ${res.status}`);
  return agent;
}

/** @param {import("supertest").Agent} request */
export async function createTable(request, name = "Тестовый стол") {
  const res = await request.post("/api/tables").send({ name });
  if (res.status !== 201) throw new Error(`createTable: ${res.status}`);
  return res.body;
}

/** @param {import("supertest").Agent} request */
export async function createTariff(request, name = "Тестовый тариф", price = 600) {
  const res = await request.post("/api/tariffs").send({ name, price_per_hour: price });
  if (res.status !== 201) throw new Error(`createTariff: ${res.status}`);
  return res.body;
}
